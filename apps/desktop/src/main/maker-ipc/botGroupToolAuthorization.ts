import type { MessageSourceGroup } from '@cindy/maker-shared/message-source';
import { t } from '../i18n.js';

/** A group link identifies a lane, not an authorization. Only its live Chat Server
 * execution may supply authority; persisted route keys cannot recreate a grant. */
export type GroupToolOperation = 'read-self' | 'owner-action';
/** A companion in the room. Names and membership are public group data. */
export interface GroupToolPeer {
  /** Room actor id: stable inside this room, never a local Bot profile id. */
  actorId: string;
  /** Local profile id when the companion runs on this device, otherwise the actor id. */
  botId: string;
  name: string;
  /** True when this device's account owns the companion. */
  owned: boolean;
}
export interface GroupToolAuthority {
  botId: string;
  sourceGroup?: MessageSourceGroup;
  mode: 'owner' | 'chat' | 'tools';
  validate(): Promise<void>;
  isCurrent(): boolean;
  /** Live room participants, re-read at the tool boundary when the transport can supply them. */
  peers?(): Promise<GroupToolPeer[]>;
}
const authorities = new Map<string, GroupToolAuthority>();

export class GroupToolAuthorizationError extends Error {
  readonly code: string;
  constructor(readonly temporary = false) {
    super(t(temporary ? 'groupTools.verificationUnavailable' : 'groupTools.authorizationRequired'));
    this.code = temporary ? 'GROUP_AUTHORIZATION_UNAVAILABLE' : 'GROUP_AUTHORIZATION_REQUIRED';
  }
}

export function registerGroupToolAuthority(sessionId: string, authority: GroupToolAuthority): () => void {
  authorities.set(sessionId, authority);
  return () => { if (authorities.get(sessionId) === authority) authorities.delete(sessionId); };
}

export async function authorizeGroupTool(sessionId: string, botId: string, operation: GroupToolOperation) {
  const authority = authorities.get(sessionId);
  const assertCurrent = () => {
    if (!authority || authorities.get(sessionId) !== authority || authority.botId !== botId
      || !authority.isCurrent() || authority.mode === 'chat'
      || (operation === 'owner-action' && authority.mode !== 'owner')) throw new GroupToolAuthorizationError();
  };
  assertCurrent();
  try { await authority!.validate(); } catch (error) {
    const revoked = error instanceof GroupToolAuthorizationError && !error.temporary;
    if (revoked && authorities.get(sessionId) === authority) authorities.delete(sessionId);
    // A transport failure denies this attempt, without permanently revoking a live lease.
    assertCurrent();
    throw new GroupToolAuthorizationError(!revoked);
  }
  assertCurrent();
  // Peers are an addition to the grant, never a substitute: read them only after the
  // same live-lease check, and re-check before returning room data to the caller.
  const peers = async (): Promise<GroupToolPeer[]> => {
    assertCurrent();
    const rows = authority!.peers ? await authority!.peers() : [];
    assertCurrent();
    return rows;
  };
  return { assertCurrent, peers, mode: authority!.mode, sourceGroup: authority!.sourceGroup, refresh: async (): Promise<void> => {
    assertCurrent();
    await authorizeGroupTool(sessionId, botId, operation);
    assertCurrent();
  } };
}
