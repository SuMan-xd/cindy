import { describe, expect, it } from 'vitest';
import { resolveBotGroupMessageMentions } from '../botGroupMentions.js';

const members = [
  { botId: 'suman', name: '苏曼' },
  { botId: 'suman-cindy', name: '苏曼的Cindy' },
  { botId: 'abu', name: 'Abu Bot' },
];

const resolve = (text: string, input: Partial<Parameters<typeof resolveBotGroupMessageMentions>[1]> = {}) =>
  resolveBotGroupMessageMentions(text, { members, ...input });

describe('resolveBotGroupMessageMentions', () => {
  it('names a teammate from the text, including a CJK name glued to the sentence', () => {
    expect(resolve('@苏曼帮我查一下')).toEqual({ all: false, botIds: ['suman'] });
    expect(resolve('@Abu Bot 先说')).toEqual({ all: false, botIds: ['abu'] });
    expect(resolve('@abu bot 先说')).toEqual({ all: false, botIds: ['abu'] });
  });

  it('takes the longest matching name, so a prefix never steals the mention', () => {
    expect(resolve('@苏曼的Cindy 看看')).toEqual({ all: false, botIds: ['suman-cindy'] });
    expect(resolve('@苏曼的Cindy，还有 @苏曼 都看')).toEqual({ all: false, botIds: ['suman-cindy', 'suman'] });
  });

  it('ignores an address inside an e-mail or identifier and a name nobody has', () => {
    expect(resolve('发给 suman@corp.com 就好')).toEqual({ all: false, botIds: [] });
    expect(resolve('@无名 你好')).toEqual({ all: false, botIds: [] });
  });

  it('drops the replying companion itself and keeps one copy of each target', () => {
    expect(resolve('@苏曼 和 @苏曼 还有 @Abu Bot', { excludeBotIds: ['suman'] }))
      .toEqual({ all: false, botIds: ['abu'] });
    expect(resolve('@苏曼 @苏曼 @苏曼')).toEqual({ all: false, botIds: ['suman'] });
  });

  it('keeps picked mentions authoritative and uses text only when nothing was picked', () => {
    expect(resolve('@苏曼 看看', { picked: { all: false, botIds: ['abu'] } }))
      .toEqual({ all: false, botIds: ['abu'] });
    expect(resolve('@苏曼 看看', { picked: { all: false, botIds: [] } }))
      .toEqual({ all: false, botIds: ['suman'] });
    // A pick that is no longer in the roster is dropped, not an error.
    expect(resolve('@苏曼 看看', { picked: { all: false, botIds: ['gone'] } }))
      .toEqual({ all: false, botIds: ['suman'] });
  });

  // bot-group-chat.md §10: 同名成员（不同主人带来的同名伙伴）手打短名时点名所有同名伙伴，
  // 从候选选中的完整名字只点名那一位。去掉 buildLabelEntries 的同名合并，第一条就会挂。
  it('names every companion sharing a short name, while a full name names only that one', () => {
    const namesakes = [
      { botId: 'cindy-chris', name: 'Cindy (Chris)', displayName: 'Cindy' },
      { botId: 'cindy-dave', name: 'Cindy (Dave)', displayName: 'Cindy' },
    ];
    const ask = (text: string) => resolveBotGroupMessageMentions(text, { members: namesakes });
    expect(ask('@Cindy 看一下')).toEqual({ all: false, botIds: ['cindy-chris', 'cindy-dave'] });
    expect(ask('@Cindy (Dave) 看一下')).toEqual({ all: false, botIds: ['cindy-dave'] });
  });

  it('honours every broadcast label and caps the list like the server contract', () => {
    expect(resolve('@所有人 开会', { picked: { all: false, botIds: ['abu'] } }))
      .toEqual({ all: true, botIds: ['abu'] });
    expect(resolve('@Everyone 开会').all).toBe(true);
    expect(resolve('@所有人看这里').all).toBe(true);
    expect(resolve('me@all.com 不是点名').all).toBe(false);
    expect(resolve('@苏曼 @Abu Bot', { limit: 1 })).toEqual({ all: false, botIds: ['suman'] });
  });
});
