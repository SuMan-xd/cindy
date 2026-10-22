/**
 * 伙伴群工具：`list_groups` / `send_group_message`（docs/product-rules/bot-group-chat.md §10）。
 *
 * 两个入口与 `list_agents` / `send_to_agent` 同一层（cindy_helper bots 类目），并且共用群服务
 * 自己的读写：列表走群服务正在用的那份列表，发言走 `postBotGroupMessage`。这里不另开一套群
 * 访问逻辑，也不实现任何"以主人身份发言"的轨道——群里的作者永远是当前这位伙伴。
 *
 * 群 lane 一律拒绝：伙伴在自己的群 lane 里答复本来就直接落在群里，再调工具等于绕开轮次规则，
 * 而且群 lane 的身份（owner / chat / tools）来自被授权的执行租约，不是主人自己的主任务。
 *
 * 对外发言不可撤回，所以"是否允许开口"由宿主的动作授权（`TASK_ACTION_TOOLS` 确认卡）决定，
 * 本模块只负责目标、成员与文本的校验，不自造授权证据。
 */
import { t } from '../i18n.js';
import type { DataOwnerBroadcastScope } from '../device-link/broadcast-tap.js';
import { BOT_GROUP_MESSAGE_MAX_CHARS, type BotGroupMemberView, type BotGroupSummary } from '../../shared/botGroupChat.js';
import { loadBotCallerSession } from './botDirectMessageService.js';
import type { BotGroupChatService } from './botGroupChatService.js';

/** 一位成员在工具视图里的样子：`isSelf` 是「调用伙伴自己」，不是界面里的「我（主人）」。 */
export interface BotGroupToolMember {
  botId: string;
  name: string;
  isSelf: boolean;
  ownerActorId?: string;
  guestAccess?: 'none' | 'chat' | 'tools';
  status: string;
}

export interface BotGroupToolRow {
  groupId: string;
  name: string;
  serverBacked: boolean;
  archived: boolean;
  organizerBotId: string | null;
  members: BotGroupToolMember[];
  openPlan: { id: string; status: string; currentStep: number | null } | null;
  lastMessage: { authorKind: string; authorName: string; preview: string; createdAt: number } | null;
  /** 调用伙伴在这个群里；false 时它不能往这里发消息。 */
  isMember: boolean;
}

export type BotGroupToolErrorCode =
  | 'NOT_A_BOT_SESSION'
  | 'NOT_CANONICAL_BOT_SESSION'
  | 'HOST_NOT_READY'
  | 'OWNER_CHANGED'
  | 'INVALID_ARGS'
  | 'GROUP_NOT_FOUND'
  | 'GROUP_ARCHIVED'
  | 'GROUP_DISSOLVED'
  | 'NOT_A_MEMBER'
  | 'BOT_UNAVAILABLE'
  | 'GROUP_UNAVAILABLE';

export interface BotGroupToolFailure {
  ok: false;
  errorCode: BotGroupToolErrorCode;
  message: string;
}

/** 一次最多返回多少个群；模型一次读不完，更多请让主人缩小范围。 */
export const BOT_GROUP_TOOL_LIMIT_DEFAULT = 20;
export const BOT_GROUP_TOOL_LIMIT_MAX = 50;
export const BOT_GROUP_TOOL_TEXT_MAX = BOT_GROUP_MESSAGE_MAX_CHARS;

function clampLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return BOT_GROUP_TOOL_LIMIT_DEFAULT;
  return Math.min(Math.max(Math.trunc(value), 1), BOT_GROUP_TOOL_LIMIT_MAX);
}

function toolMember(member: BotGroupMemberView, callerBotId: string): BotGroupToolMember {
  return {
    botId: member.botId,
    name: member.name,
    // The tool's reader is the calling companion, not the owner looking at the UI.
    isSelf: member.botId === callerBotId || member.actorId === callerBotId,
    ...(member.ownerActorId ? { ownerActorId: member.ownerActorId } : {}),
    ...(member.guestAccess ? { guestAccess: member.guestAccess } : {}),
    status: member.status,
  };
}

/**
 * 群列表到工具视图：服务器群和本地群都按同一个形状出现，按最近活动排序，再截到 `limit`。
 * 不拉历史：`lastMessage` 只是群摘要里已有的那一条预览。
 */
export function projectBotGroupToolRows(
  groups: readonly BotGroupSummary[],
  input: { callerBotId: string; limit?: number },
): BotGroupToolRow[] {
  return [...groups]
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    .slice(0, clampLimit(input.limit))
    .map((group) => ({
      groupId: group.id,
      name: group.name,
      serverBacked: group.serverBacked === true,
      archived: group.archived === true,
      organizerBotId: group.organizerBotId,
      members: group.members.map((member) => toolMember(member, input.callerBotId)),
      openPlan: group.openPlan
        ? { id: group.openPlan.id, status: group.openPlan.status, currentStep: group.openPlan.currentStep }
        : null,
      lastMessage: group.lastMessage
        ? {
            authorKind: group.lastMessage.authorKind,
            authorName: group.lastMessage.authorName,
            preview: group.lastMessage.preview,
            createdAt: group.lastMessage.createdAt,
          }
        : null,
      isMember: group.members.some((member) => member.botId === input.callerBotId || member.actorId === input.callerBotId),
    }));
}

/** 群服务里这两个工具真正用到的那部分能力。 */
export type BotGroupToolGroups = Pick<
  BotGroupChatService,
  'listGroups' | 'botGroupListForTool' | 'getGroup' | 'postBotGroupMessage'
>;

export interface BotGroupToolsServiceDeps {
  /** 运行期现取的群服务；未装好时返回 null，工具明确报未就绪而不是假装没群。 */
  groups: () => BotGroupToolGroups | null;
  captureOwnerScope?: () => DataOwnerBroadcastScope;
  isOwnerScopeCurrent?: (scope: DataOwnerBroadcastScope) => boolean;
  createId: () => string;
  log?: { warn: (message: string, meta?: Record<string, unknown>) => void };
}

type Caller = { ok: true; botId: string; botName: string } | BotGroupToolFailure;

export function createBotGroupToolsService(deps: BotGroupToolsServiceDeps) {
  const groups = () => deps.groups();
  const ownerIsCurrent = (scope: DataOwnerBroadcastScope | undefined) =>
    scope === undefined || !deps.isOwnerScopeCurrent || deps.isOwnerScopeCurrent(scope);

  /**
   * 群工具只认伙伴自己的主任务：主聊天（canonical）与伙伴私聊话题（thread）。
   * 其余一律拒绝：群 lane（group）在群里本来就有一条自己的回复通道；IM 接管的渠道
   * （channel）、历史链接（history）与子任务（delegation）都不是主人自己的主任务，
   * 对外发言不能从那里发起。
   */
  const callerFor = async (callerSessionId: string): Promise<Caller> => {
    const caller = await loadBotCallerSession(callerSessionId);
    if (!caller || caller.sessionSource !== 'bot' || caller.sessionStatus !== 'active'
      || caller.botStatus !== 'active' || caller.linkArchivedAt !== null)
      return { ok: false, errorCode: 'NOT_A_BOT_SESSION', message: t('groupTools.botSessionRequired') };
    if (caller.role !== 'canonical' && caller.role !== 'thread')
      return { ok: false, errorCode: 'NOT_CANONICAL_BOT_SESSION', message: t('groupTools.groupLaneNotAllowed') };
    return { ok: true, botId: caller.botId, botName: caller.botName };
  };

  const listGroups = async (input: { callerSessionId: string; limit?: number }): Promise<
    { ok: true; groups: BotGroupToolRow[]; total: number } | BotGroupToolFailure
  > => {
    const caller = await callerFor(input.callerSessionId);
    if (!caller.ok) return caller;
    const service = groups();
    if (!service) return { ok: false, errorCode: 'HOST_NOT_READY', message: t('groupTools.groupServiceUnavailable') };
    const scope = deps.captureOwnerScope?.();
    const listed = await service.botGroupListForTool();
    if (!listed.ok) return { ok: false, errorCode: 'GROUP_UNAVAILABLE', message: listed.message };
    // 账号在读取过程中切换：这份列表属于上一个账号，不能交给这个伙伴。
    if (!ownerIsCurrent(scope))
      return { ok: false, errorCode: 'OWNER_CHANGED', message: t('groupTools.ownerChanged') };
    return {
      ok: true,
      groups: projectBotGroupToolRows(listed.groups, { callerBotId: caller.botId, limit: input.limit }),
      total: listed.groups.length,
    };
  };

  const sendGroupMessage = async (input: {
    callerSessionId: string;
    groupId: string;
    text: string;
    idempotencyKey?: string;
  }): Promise<
    | {
        ok: true;
        groupId: string;
        groupName: string;
        serverBacked: boolean;
        messageId: string;
        mentioned: Array<{ botId: string; name: string }>;
      }
    | BotGroupToolFailure
  > => {
    const caller = await callerFor(input.callerSessionId);
    if (!caller.ok) return caller;
    const groupId = typeof input.groupId === 'string' ? input.groupId.trim() : '';
    if (!groupId) return { ok: false, errorCode: 'INVALID_ARGS', message: t('groupTools.invalidGroupId') };
    // 空消息与超长消息在落库前就拒绝：群消息不可撤回，不能半条。
    const text = typeof input.text === 'string' ? input.text.trim() : '';
    if (!text) return { ok: false, errorCode: 'INVALID_ARGS', message: t('groupTools.emptyMessage') };
    if (Array.from(text).length > BOT_GROUP_TOOL_TEXT_MAX)
      return {
        ok: false,
        errorCode: 'INVALID_ARGS',
        message: t('groupTools.messageTooLong').replace('{{max}}', String(BOT_GROUP_TOOL_TEXT_MAX)),
      };
    const service = groups();
    if (!service) return { ok: false, errorCode: 'HOST_NOT_READY', message: t('groupTools.groupServiceUnavailable') };
    const scope = deps.captureOwnerScope?.();
    const snapshot = await service.getGroup(groupId);
    if (!snapshot.ok)
      return {
        ok: false,
        errorCode: snapshot.errorCode === 'NOT_FOUND' ? 'GROUP_NOT_FOUND' : 'GROUP_UNAVAILABLE',
        message: snapshot.message,
      };
    const group = snapshot.group;
    if (group.dissolvedAt) return { ok: false, errorCode: 'GROUP_DISSOLVED', message: t('groupTools.groupDissolved') };
    if (group.archived) return { ok: false, errorCode: 'GROUP_ARCHIVED', message: t('groupTools.groupArchived') };
    const self = group.members.find(
      (member) => member.botId === caller.botId || member.actorId === caller.botId,
    );
    if (!self) return { ok: false, errorCode: 'NOT_A_MEMBER', message: t('groupTools.notAMember') };
    if (self.status !== 'active') return { ok: false, errorCode: 'BOT_UNAVAILABLE', message: t('groupTools.botUnavailable') };
    if (!ownerIsCurrent(scope))
      return { ok: false, errorCode: 'OWNER_CHANGED', message: t('groupTools.ownerChanged') };
    // 同一条消息重试只落一条：重试标识按调用会话隔离，调用方没给就用本次调用自己的 id。
    const clientId = `bot-group-tool:${input.callerSessionId}:${input.idempotencyKey?.trim() || deps.createId()}`;
    const posted = await service.postBotGroupMessage({ groupId, botId: caller.botId, text, clientId });
    if (!posted.ok) {
      if (posted.errorCode === 'NOT_FOUND') return { ok: false, errorCode: 'GROUP_NOT_FOUND', message: posted.message };
      if (posted.errorCode === 'PERMISSION_DENIED') return { ok: false, errorCode: 'NOT_A_MEMBER', message: posted.message };
      if (posted.errorCode === 'MEMBER_UNAVAILABLE') return { ok: false, errorCode: 'BOT_UNAVAILABLE', message: posted.message };
      if (posted.errorCode === 'GROUP_ARCHIVED') return { ok: false, errorCode: 'GROUP_ARCHIVED', message: posted.message };
      if (posted.errorCode === 'GROUP_DISSOLVED') return { ok: false, errorCode: 'GROUP_DISSOLVED', message: posted.message };
      deps.log?.warn('Bot group message was not stored', { groupId, errorCode: posted.errorCode });
      return { ok: false, errorCode: 'GROUP_UNAVAILABLE', message: posted.message };
    }
    return {
      ok: true,
      groupId,
      groupName: group.name,
      serverBacked: group.serverBacked === true,
      messageId: posted.messageId,
      mentioned: posted.mentionedBotIds.map((botId) => ({
        botId,
        name: group.members.find((member) => member.botId === botId)?.name ?? botId,
      })),
    };
  };

  return { listGroups, sendGroupMessage };
}

export type BotGroupToolsService = ReturnType<typeof createBotGroupToolsService>;
