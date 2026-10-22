'use strict';

const knowhowLibrary = require('../src/utils/knowhow-library');

describe('knowhow library expert mode', () => {
  test('loads 2026-05 operating meeting additions into expert mode context', () => {
    const context = knowhowLibrary.getFullContextForExpertMode();

    expect(context).toContain('[project_exit_redline] 亏损/低利项目去留 / 报价边界');
    expect(context).toContain('[annual_forecast_calibration] 年度目标缺口 / 滚动预测校准');
    expect(context).toContain('[customer_sku_portfolio_focus] 客户与SKU组合优先级 / 好客户画像');
    expect(context).toContain('停、留、涨价、降本、冻结新增投入必须明确');
  });

  test('selects new project exit and forecast playbooks by keyword', () => {
    const projectExitPrompt = knowhowLibrary.formatForPrompt(
      '低利项目应该怎么做项目去留判断和报价边界调整？',
      null,
    );
    const forecastPrompt = knowhowLibrary.formatForPrompt(
      '年度目标缺口很大，滚动预测偏差怎么校准？',
      null,
    );

    expect(projectExitPrompt).toContain('亏损/低利项目去留 / 报价边界');
    expect(projectExitPrompt).toContain('继续做的前提是什么');
    expect(forecastPrompt).toContain('年度目标缺口 / 滚动预测校准');
    expect(forecastPrompt).toContain('历史惯性、滚动保守、滚动基准和目标倒推');
  });

  test('matches new fallback strategy indicators', () => {
    const strategies = knowhowLibrary.matchStrategies({
      lowMarginProjects: true,
      targetGap: true,
      customerConcentration: true,
      caliberIssue: true,
    });

    expect(strategies.map(item => item.id)).toEqual(expect.arrayContaining([
      'project_exit_redline',
      'annual_forecast_calibration',
      'customer_sku_portfolio_focus',
      'business_caliber_operating_literacy',
    ]));
  });
});
