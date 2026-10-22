/**
 * Value: `list_groups` / `send_group_message` 的宿主侧投影与拒绝路径（群工具入口）。
 * Bug/rule basis: bot-group-chat.md §10 —— 伙伴只能在主人授权下、以自己的身份在群里发言；
 *   list_groups 只读且必须有上界，任何"以主人身份发言"或群 lane 代发都不允许。
 * Coverage gap: 上一轮只覆盖"回复里的 @ 落成 mentions"；群工具入口、投影字段、错误码与
 *   非 canonical 调用都没有用例。
 * Minimum failing input: 群 lane（role=group）会话调用 send_group_message，或不在群里的伙伴发言。
 * Tier: unit（注入群服务与调用者，无网络、无数据库）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({
  caller: vi.fn(),
}));

vi.mock('../../i18n.js', () => ({ t: (key: string) => key }));
vi.mock('../botDirectMessageService.js', () => ({ loadBotCallerSession: host.caller }));

import { createBotGroupToolsService, projectBotGroupToolRows } from '../botGroupTools.js';
import type { BotGroupDetail, BotGroupMemberView, BotGroupSummary } from '../../../shared/botGroupChat.js';

function member(overrides: Partial<BotGroupMemberView> & { botId: string; name: string }): BotGroupMemberView {
  return {
    avatar: '🤖', avatarColor: 'violet', status: 'active',
    ...overrides,
  } as BotGroupMemberView;
}

function summary(overrides: Partial<BotGroupSummary> & { id: string; name: string }): BotGroupSummary {
  return {
    replyMode: 'all', speakingMode: 'auto', members: [], organizerBotId: null, projectDir: null,
    lastMessage: null, speakingBotIds: [], planningBotId: null, openPlan: null,
    createdAt: 1, updatedAt: 1,
    ...overrides,
  } as BotGroupSummary;
}

function detail(group: BotGroupSummary): BotGroupDetail {
  return { ...group, messages: [], hasMoreBefore: false, plans: [], round: { status: 'idle', speakers: [], canContinue: false } } as BotGroupDetail;
}

const serverGroup = summary({
  id: 'room-1', name: '周末出游', serverBacked: true, archived: false, organizerBotId: 'xiaoman',
  updatedAt: 30,
  members: [
    member({ botId: 'mimi', actorId: 'actor-mimi', name: '咪咪', isSelf: false, ownerActorId: 'owner-1', guestAccess: 'tools', status: 'active' }),
    member({ botId: 'xiaoman', actorId: 'actor-xiaoman', name: '小满', isSelf: false, ownerActorId: 'owner-2', guestAccess: 'chat', status: 'paused' }),
  ],
  openPlan: { id: 'plan-1', status: 'running', currentStep: 1, stepCount: 3, currentBotName: '小满', currentStepStatus: 'running' },
  lastMessage: { authorKind: 'bot', authorName: '小满', preview: '我投杭州', createdAt: 30 },
});

const localGroup = summary({
  id: 'local-1', name: '老群', archived: false, organizerBotId: 'mimi', updatedAt: 20,
  members: [
    member({ botId: 'mimi', name: '咪咪', status: 'active' }),
    member({ botId: 'abu', name: '阿布', status: 'active' }),
  ],
  lastMessage: { authorKind: 'user', authorName: '', preview: '明早出发', createdAt: 20 },
});

const archivedGroup = summary({
  id: 'room-2', name: '去年的群', serverBacked: true, archived: true, organizerBotId: null,
  updatedAt: 10, members: [member({ botId: 'mimi', name: '咪咪', status: 'active' })],
});

function service(groups: BotGroupSummary[], overrides: Partial<Record<'getGroup' | 'postBotGroupMessage' | 'botGroupListForTool' | 'listGroups', unknown>> = {}) {
  const calls = { post: [] as Array<{ groupId: string; botId: string; text: string; clientId: string }> };
  const groupsService = {
    listGroups: vi.fn(async () => ({ ok: true as const, groups })),
    botGroupListForTool: vi.fn(async () => ({ ok: true as const, groups })),
    getGroup: vi.fn(async (groupId: string) => {
      const group = groups.find(group => group.id === groupId);
      return group ? { ok: true as const, group: detail(group) } : { ok: false as const, errorCode: 'NOT_FOUND' as const, message: '群聊不存在' };
    }),
    postBotGroupMessage: vi.fn(async (input: { groupId: string; botId: string; text: string; clientId: string }) => {
      calls.post.push(input);
      return { ok: true as const, messageId: 'message-1', mentionedBotIds: ['xiaoman'] };
    }),
    ...overrides,
  };
  let ids = 0;
  const tools = createBotGroupToolsService({
    groups: () => groupsService as never,
    createId: () => `id-${++ids}`,
  });
  return { tools, groups: groupsService, calls };
}

describe('group tools', () => {
  beforeEach(() => {
    host.caller.mockReset();
    host.caller.mockResolvedValue({
      botId: 'mimi', role: 'canonical', linkArchivedAt: null, botName: '咪咪',
      sessionSource: 'bot', sessionStatus: 'active', botStatus: 'active',
    });
  });

  it('lists server-backed and local groups with every member field, newest first and bounded', async () => {
    const { tools } = service([localGroup, archivedGroup, serverGroup]);
    const listed = await tools.listGroups({ callerSessionId: 'bot-session', limit: 2 });
    if (!listed.ok) throw new Error(listed.message);
    // `limit` caps the answer; `total` still reports the whole list.
    expect(listed.total).toBe(3);
    expect(listed.groups.map(group => group.groupId)).toEqual(['room-1', 'local-1']);
    const [room, local] = listed.groups;
    expect(room).toMatchObject({
      name: '周末出游', serverBacked: true, archived: false, organizerBotId: 'xiaoman',
      openPlan: { id: 'plan-1', status: 'running', currentStep: 1 },
      lastMessage: { authorKind: 'bot', authorName: '小满', preview: '我投杭州', createdAt: 30 },
      isMember: true,
    });
    // `isSelf` is the calling teammate, whatever the viewer column says in the UI.
    expect(room!.members).toEqual([
      { botId: 'mimi', name: '咪咪', isSelf: true, ownerActorId: 'owner-1', guestAccess: 'tools', status: 'active' },
      { botId: 'xiaoman', name: '小满', isSelf: false, ownerActorId: 'owner-2', guestAccess: 'chat', status: 'paused' },
    ]);
    // A local group has no server identity, owner actors or guest grants to report.
    expect(local).toMatchObject({ serverBacked: false, archived: false });
    expect(local!.members).toEqual([
      { botId: 'mimi', name: '咪咪', isSelf: true, status: 'active' },
      { botId: 'abu', name: '阿布', isSelf: false, status: 'active' },
    ]);
    // The default limit is deterministic and still bounded.
    const wide = await tools.listGroups({ callerSessionId: 'bot-session' });
    expect(wide.ok && wide.groups).toHaveLength(3);
    const capped = await tools.listGroups({ callerSessionId: 'bot-session', limit: 999 });
    expect(capped.ok && capped.groups).toHaveLength(3);
  });

  it('projects only the documented fields and never reads history', () => {
    const rows = projectBotGroupToolRows([serverGroup], { callerBotId: 'mimi', limit: 20 });
    expect(Object.keys(rows[0]!).sort()).toEqual([
      'archived', 'groupId', 'isMember', 'lastMessage', 'members', 'name', 'openPlan', 'organizerBotId', 'serverBacked',
    ]);
    expect(rows[0]!.lastMessage!.preview).toBe('我投杭州');
  });

  it('posts as the calling teammate and reports who the message names', async () => {
    const { tools, calls } = service([serverGroup]);
    const posted = await tools.sendGroupMessage({
      callerSessionId: 'bot-session', groupId: 'room-1', text: '  @小满 帮我看下  ', idempotencyKey: 'retry-1',
    });
    expect(posted).toMatchObject({
      ok: true, groupId: 'room-1', groupName: '周末出游', serverBacked: true, messageId: 'message-1',
      mentioned: [{ botId: 'xiaoman', name: '小满' }],
    });
    // The author is resolved from the caller's own Session, and the retry key is namespaced per caller.
    expect(calls.post).toEqual([
      { groupId: 'room-1', botId: 'mimi', text: '@小满 帮我看下', clientId: 'bot-group-tool:bot-session:retry-1' },
    ]);
  });

  it('refuses an archived, dissolved, foreign, paused, empty, overlong or unknown target with its own code', async () => {
    const { tools, calls } = service([
      serverGroup,
      archivedGroup,
      summary({ id: 'room-3', name: '解散了的群', serverBacked: true, dissolvedAt: '2026-10-01T00:00:00Z', members: [member({ botId: 'mimi', name: '咪咪', status: 'active' })] }),
      summary({ id: 'room-4', name: '别人的群', serverBacked: true, members: [member({ botId: 'abu', name: '阿布', status: 'active' })] }),
      summary({ id: 'room-5', name: '我暂停了', serverBacked: true, members: [member({ botId: 'mimi', name: '咪咪', status: 'paused' })] }),
    ]);
    const send = (groupId: string, text = '在吗') => tools.sendGroupMessage({ callerSessionId: 'bot-session', groupId, text });
    expect(await send('missing')).toMatchObject({ ok: false, errorCode: 'GROUP_NOT_FOUND' });
    expect(await send('room-2')).toMatchObject({ ok: false, errorCode: 'GROUP_ARCHIVED' });
    expect(await send('room-3')).toMatchObject({ ok: false, errorCode: 'GROUP_DISSOLVED' });
    expect(await send('room-4')).toMatchObject({ ok: false, errorCode: 'NOT_A_MEMBER' });
    expect(await send('room-5')).toMatchObject({ ok: false, errorCode: 'BOT_UNAVAILABLE' });
    expect(await send('room-1', '   ')).toMatchObject({ ok: false, errorCode: 'INVALID_ARGS' });
    expect(await send('room-1', '长'.repeat(8_001))).toMatchObject({ ok: false, errorCode: 'INVALID_ARGS' });
    expect(await tools.sendGroupMessage({ callerSessionId: 'bot-session', groupId: '  ', text: '在吗' }))
      .toMatchObject({ ok: false, errorCode: 'INVALID_ARGS' });
    // Nothing reached storage for any refusal.
    expect(calls.post).toEqual([]);
  });

  it.each(['group', 'channel', 'history', 'delegation'] as const)(
    'never speaks from a %s lane, an inactive Session, or a switched account',
    async role => {
      const { tools, calls } = service([serverGroup]);
      host.caller.mockResolvedValue({
        botId: 'mimi', role, linkArchivedAt: null, botName: '咪咪',
        sessionSource: 'bot', sessionStatus: 'active', botStatus: 'active',
      });
      expect(await tools.sendGroupMessage({ callerSessionId: 'lane-session', groupId: 'room-1', text: '@小满 在吗' }))
        .toMatchObject({ ok: false, errorCode: 'NOT_CANONICAL_BOT_SESSION' });
      expect(await tools.listGroups({ callerSessionId: 'lane-session' }))
        .toMatchObject({ ok: false, errorCode: 'NOT_CANONICAL_BOT_SESSION' });
      expect(calls.post).toEqual([]);
    },
  );

  it('refuses a Session with no live Bot link and a user task', async () => {
    const { tools, calls } = service([serverGroup]);
    host.caller.mockResolvedValue({ botId: 'mimi', role: 'canonical', linkArchivedAt: 7, botName: '咪咪',
      sessionSource: 'bot', sessionStatus: 'active', botStatus: 'active' });
    expect(await tools.sendGroupMessage({ callerSessionId: 'old-session', groupId: 'room-1', text: '在吗' }))
      .toMatchObject({ ok: false, errorCode: 'NOT_A_BOT_SESSION' });
    host.caller.mockResolvedValue({ botId: 'mimi', role: 'canonical', linkArchivedAt: null, botName: '咪咪',
      sessionSource: 'bot', sessionStatus: 'active', botStatus: 'paused' });
    expect(await tools.listGroups({ callerSessionId: 'paused-session' }))
      .toMatchObject({ ok: false, errorCode: 'NOT_A_BOT_SESSION' });
    // A plain user task has no Bot link at all.
    host.caller.mockResolvedValue(undefined);
    expect(await tools.listGroups({ callerSessionId: 'user-task' }))
      .toMatchObject({ ok: false, errorCode: 'NOT_A_BOT_SESSION' });
    expect(calls.post).toEqual([]);
  });

  it('reports an account switch instead of posting into the next account’s group', async () => {
    let current = true;
    const groupsService = {
      listGroups: vi.fn(async () => ({ ok: true as const, groups: [serverGroup] })),
      botGroupListForTool: vi.fn(async () => ({ ok: true as const, groups: [serverGroup] })),
      getGroup: vi.fn(async () => ({ ok: true as const, group: detail(serverGroup) })),
      postBotGroupMessage: vi.fn(async () => ({ ok: true as const, messageId: 'message-1', mentionedBotIds: [] })),
    };
    const tools = createBotGroupToolsService({
      groups: () => groupsService as never,
      captureOwnerScope: () => ({ kind: 'owner', dataOwnerId: 'owner-1' }) as never,
      isOwnerScopeCurrent: () => current,
      createId: () => 'id-1',
    });
    current = false;
    expect(await tools.listGroups({ callerSessionId: 'bot-session' }))
      .toMatchObject({ ok: false, errorCode: 'OWNER_CHANGED' });
    expect(await tools.sendGroupMessage({ callerSessionId: 'bot-session', groupId: 'room-1', text: '在吗' }))
      .toMatchObject({ ok: false, errorCode: 'OWNER_CHANGED' });
    expect(groupsService.postBotGroupMessage).not.toHaveBeenCalled();
  });
});
