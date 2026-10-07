/**
 * 贡献点注册表单测（registry）。
 * 覆盖：命令 id 重复处理、命令 handler 归属校验、卸载时物理清理贡献项、
 * 导航/状态栏项按 id 原地更新、内置共享视图组件保护。
 *
 * 注意：registry 是模块级单例，测试用**各用例独立的扩展 id** 避免相互污染。
 */
import { describe, expect, it, vi } from 'vitest'
import { registry } from '../src/renderer/src/core/registry'
import type { Component } from 'vue'

const dummy = {} as Component

describe('registry · 命令注册与 handler 归属', () => {
  const cmd = (id: string): { command: string; title: string } => ({ command: id, title: id })

  it('重复命令 id：保留第一个并告警', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    registry.registerCommand('ext-dup-a', cmd('ext-dup-a.cmd'))
    registry.registerCommand('ext-dup-b', cmd('ext-dup-a.cmd'))
    const found = registry.commands.filter((c) => c.command === 'ext-dup-a.cmd')
    expect(found).toHaveLength(1)
    expect(found[0].extensionId).toBe('ext-dup-a')
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
    registry.unregisterExtension('ext-dup-a')
    registry.unregisterExtension('ext-dup-b')
  })

  it('只能绑定本扩展声明的命令：跨扩展绑定被拒绝并告警', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    registry.registerCommand('ext-own', cmd('ext-own.cmd'))
    registry.setCommandHandler('ext-own.cmd', () => 'hijacked', 'ext-foreign')
    expect(registry.commands.find((c) => c.command === 'ext-own.cmd')?.handler).toBeUndefined()
    expect(warn).toHaveBeenCalled()

    const h = (): string => 'ok'
    registry.setCommandHandler('ext-own.cmd', h, 'ext-own')
    expect(registry.commands.find((c) => c.command === 'ext-own.cmd')?.handler).toBe(h)
    warn.mockRestore()
    registry.unregisterExtension('ext-own')
  })

  it('未声明命令 → setCommandHandler 抛错', () => {
    expect(() => registry.setCommandHandler('nope.cmd', () => 1, 'ext-x')).toThrow()
  })

  it('绑定返回的 dispose 会清掉 handler', () => {
    registry.registerCommand('ext-dispose', cmd('ext-dispose.cmd'))
    const d = registry.setCommandHandler('ext-dispose.cmd', () => 1, 'ext-dispose')
    d.dispose()
    expect(registry.commands.find((c) => c.command === 'ext-dispose.cmd')?.handler).toBeUndefined()
    registry.unregisterExtension('ext-dispose')
  })
})

describe('registry · 卸载时物理清理（regression）', () => {
  it('unregisterExtension 移除该扩展的命令/导航项/状态栏项/菜单与索引', () => {
    registry.registerCommand('ext-gone', { command: 'ext-gone.cmd', title: 'C' })
    registry.registerNavItem('ext-gone', { id: 'ext-gone.nav', title: 'N', icon: '<svg/>' })
    registry.registerStatusBarItem('ext-gone', { id: 'ext-gone.sb', name: 'S' })
    registry.registerMenu('ext-gone', { command: 'ext-gone.cmd' })

    registry.unregisterExtension('ext-gone')

    expect(registry.commands.some((c) => c.extensionId === 'ext-gone')).toBe(false)
    expect(registry.navItems.some((i) => i.extensionId === 'ext-gone')).toBe(false)
    expect(registry.statusBarItems.some((i) => i.extensionId === 'ext-gone')).toBe(false)
    expect(registry.menus.some((m) => m.extensionId === 'ext-gone')).toBe(false)
  })

  it('卸载后同 id 命令可被重新声明（此前会永久占位被判重复）', () => {
    registry.registerCommand('ext-reinstall', { command: 'ext-reinstall.cmd', title: 'C' })
    registry.unregisterExtension('ext-reinstall')
    registry.registerCommand('ext-reinstall2', { command: 'ext-reinstall.cmd', title: 'C2' })
    const found = registry.commands.filter((c) => c.command === 'ext-reinstall.cmd')
    expect(found).toHaveLength(1)
    expect(found[0].extensionId).toBe('ext-reinstall2')
    registry.unregisterExtension('ext-reinstall2')
  })

  it('deactivateExtension 只标记 inactive（保留条目供 UI 展示）', () => {
    registry.registerNavItem('ext-deact', { id: 'ext-deact.nav', title: 'N', icon: '<svg/>' })
    registry.deactivateExtension('ext-deact')
    const item = registry.navItems.find((i) => i.id === 'ext-deact.nav')
    expect(item).toBeDefined()
    expect(item?.active).toBe(false)
    expect(registry.getNavItems('top').some((i) => i.id === 'ext-deact.nav')).toBe(false)
    registry.unregisterExtension('ext-deact')
  })
})

describe('registry · 导航项/状态栏项按 id 原地更新', () => {
  it('同 id 重复注册不新增条目（覆盖安装不再堆积）', () => {
    registry.registerNavItem('ext-up', { id: 'ext-up.nav', title: '旧', icon: '<svg/>' })
    registry.registerNavItem('ext-up', { id: 'ext-up.nav', title: '新', icon: '<svg2/>' })
    const items = registry.navItems.filter((i) => i.id === 'ext-up.nav')
    expect(items).toHaveLength(1)
    expect(items[0].title).toBe('新')

    registry.registerStatusBarItem('ext-up', { id: 'ext-up.sb', name: '旧名' })
    registry.registerStatusBarItem('ext-up', { id: 'ext-up.sb', name: '新名', text: 't' })
    const sbs = registry.statusBarItems.filter((i) => i.id === 'ext-up.sb')
    expect(sbs).toHaveLength(1)
    expect(sbs[0].name).toBe('新名')
    registry.unregisterExtension('ext-up')
  })
})

describe('registry · 视图组件清理保护共享组件', () => {
  it('移除扩展视图组件时跳过内置共享组件（obox.*），只删自己的', () => {
    // 该扩展贡献两个导航项：一个用内置共享组件 obox.tree（树视图），一个用自己的组件
    registry.registerNavItem('ext-view', {
      id: 'ext-view.nav1',
      title: '树',
      icon: '<svg/>',
      view: 'obox.tree'
    })
    registry.registerNavItem('ext-view', {
      id: 'ext-view.nav2',
      title: '自有',
      icon: '<svg/>',
      view: 'ext-view.own'
    })
    registry.registerViewComponent('obox.tree', dummy)
    registry.registerViewComponent('ext-view.own', dummy)
    registry.removeViewComponents('ext-view')
    // 共享组件保留（否则其它扩展的树视图会一起失效直至重启）
    expect(registry.viewComponents.get('obox.tree')).toBe(dummy)
    expect(registry.viewComponents.get('ext-view.own')).toBeUndefined()
    registry.unregisterExtension('ext-view')
  })
})
