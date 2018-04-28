import { forEachValue } from '../util'

// Base data struct for store's module, package with some attribute and method
/**
 *  store中，一个module的基本构造，会在原有对象中添加一些框架指定的属性与方法
 */
export default class Module {
  /**
   * 根据原Module构造一个Module对象
   * @param rawModule
   * @param runtime   是否为运行时所需模块，true则不许注销
   */
  constructor (rawModule, runtime) {
    // 是否为运行时的临时模块，涉及到能否在ModuleCollection进行模块的动态unregister
    this.runtime = runtime
    // Store some children item
    this._children = Object.create(null)
    // this._rawModule记录传入的初始Module对象
    this._rawModule = rawModule

    /**
     * this.state记录rawModule中初始传入的状态，它支持使用Object或function
     * 如果传入function，那么将其执行后得到结果，注入到this.state
     */
    const rawState = rawModule.state
    this.state = (typeof rawState === 'function' ? rawState() : rawState) || {}
  }

  // 直接返回_rawModule的namespaced字段的boolean性
  get namespaced () {
    return !!this._rawModule.namespaced
  }

  // 添加一个子模块（放进this._children字典）
  addChild (key, module) {
    this._children[key] = module
  }

  // 移除一个子模块（从this._children字典删除该属性）
  removeChild (key) {
    delete this._children[key]
  }

  // 读取一个子模块
  getChild (key) {
    return this._children[key]
  }

  /**
   * 传入一个新的rawModule，在原有基础上，覆盖其namespaced, actions, mutations和getters字段
   * @param rawModule
   */
  update (rawModule) {
    this._rawModule.namespaced = rawModule.namespaced
    if (rawModule.actions) {
      this._rawModule.actions = rawModule.actions
    }
    if (rawModule.mutations) {
      this._rawModule.mutations = rawModule.mutations
    }
    if (rawModule.getters) {
      this._rawModule.getters = rawModule.getters
    }
  }

  /**
   * 以下都是forEach操作，遍历执行一个function
   */
  forEachChild (fn) {
    forEachValue(this._children, fn)
  }

  forEachGetter (fn) {
    if (this._rawModule.getters) {
      forEachValue(this._rawModule.getters, fn)
    }
  }

  forEachAction (fn) {
    if (this._rawModule.actions) {
      forEachValue(this._rawModule.actions, fn)
    }
  }

  forEachMutation (fn) {
    if (this._rawModule.mutations) {
      forEachValue(this._rawModule.mutations, fn)
    }
  }
}
