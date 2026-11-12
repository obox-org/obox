import { describe, expect, it } from 'vitest'
import { buildInstalledNotice } from '../src/main/installNotify'

/**
 * 「扩展已安装」系统通知的文案（change `notify-extension-installed`）。
 *
 * 为什么单独测文案：通知是**安装成功后唯一立刻可见的反馈**（列表刷新只在「扩展」页里，
 * App 卡片要重启才出现），措辞必须同时讲清三件事——装了哪个扩展、什么版本、下一步要重启。
 * 文案也是唯一随语言变化的部分，zh/en 两条都得钉住。
 */
describe('安装通知文案', () => {
  const fresh = { name: 'rdp', displayName: '远程桌面', version: '1.1.1', replaced: false }
  const upgraded = {
    name: 'rdp',
    displayName: '远程桌面',
    version: '1.1.1',
    replaced: true,
    previousVersion: '1.1.0'
  }

  it('中文 · 首次安装：标题含"已安装"，正文含扩展名、版本与重启动作', () => {
    const notice = buildInstalledNotice(fresh, 'zh')
    expect(notice.title).toContain('已安装')
    expect(notice.body).toContain('远程桌面')
    expect(notice.body).toContain('v1.1.1')
    expect(notice.body).toContain('重启')
  })

  it('中文 · 覆盖安装：说明从哪个版本升到哪个版本', () => {
    const notice = buildInstalledNotice(upgraded, 'zh')
    expect(notice.title).toContain('已更新')
    expect(notice.body).toContain('v1.1.0')
    expect(notice.body).toContain('v1.1.1')
  })

  it('英文：标题/正文同义，不说中文', () => {
    // 英文场景用无 displayName 的条目：displayName 是清单里的原文，可能本来就是中文
    const notice = buildInstalledNotice({ name: 'rdp', version: '1.1.1', replaced: false }, 'en')
    expect(notice.title).toBe('Extension installed')
    expect(notice.body).toContain('rdp')
    expect(notice.body).toContain('v1.1.1')
    expect(notice.body).toMatch(/restart/i)
    expect(/[\u4e00-\u9fff]/.test(notice.title + notice.body)).toBe(false)
  })

  it('缺 displayName 时回落到 manifest.name（不让通知出现空名字）', () => {
    const notice = buildInstalledNotice({ name: 'todo', version: '1.2.0', replaced: false }, 'zh')
    expect(notice.body).toContain('todo')
  })

  it('replaced 但没有 previousVersion 时按首次安装措辞（不编造旧版本号）', () => {
    const notice = buildInstalledNotice({ name: 'rdp', version: '1.1.1', replaced: true }, 'zh')
    expect(notice.body).toContain('已安装')
    expect(notice.body).not.toContain('升级')
  })

  it('同版本覆盖安装（重装修复）不说成"升级"', () => {
    const notice = buildInstalledNotice(
      { name: 'rdp', version: '1.1.1', replaced: true, previousVersion: '1.1.1' },
      'zh'
    )
    expect(notice.title).toContain('已安装')
    expect(notice.body).not.toContain('升级')
    expect(notice.body).toContain('v1.1.1')
  })
})
