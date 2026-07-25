import { getItemType, getRiskLevel, sortItemsByRisk, ITEM_TYPE, RISK_LEVEL } from './constants';

describe('workbench constants', () => {
  test('六种审核类型均有中文标签', () => {
    expect(Object.keys(ITEM_TYPE)).toEqual(
      expect.arrayContaining(['strategy', 'candidate', 'outreach', 'reply', 'budget', 'exception'])
    );
    expect(getItemType('strategy').label).toBe('策略审核');
    expect(getItemType('candidate').label).toBe('候选达人');
    expect(getItemType('outreach').label).toBe('触达邮件');
    expect(getItemType('reply').label).toBe('达人回复');
    expect(getItemType('budget').label).toBe('预算审核');
    expect(getItemType('exception').label).toBe('异常处理');
  });

  test('未知类型/风险等级有兜底', () => {
    expect(getItemType(undefined).label).toBe('未知类型');
    expect(getItemType('other').label).toBe('other');
    expect(getRiskLevel(undefined)).toEqual(RISK_LEVEL.none);
  });

  test('决策队列按 高风险 > 低风险 > 无风险 排序，同级保持原顺序', () => {
    const items = [
      { id: 'a', risk_level: 'none' },
      { id: 'b', risk_level: 'high' },
      { id: 'c', risk_level: 'low' },
      { id: 'd', risk_level: 'high' },
      { id: 'e', risk_level: undefined }
    ];
    expect(sortItemsByRisk(items).map((i) => i.id)).toEqual(['b', 'd', 'c', 'a', 'e']);
    // 不修改入参数组
    expect(items[0].id).toBe('a');
  });
});
