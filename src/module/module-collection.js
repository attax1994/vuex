import Module from './module'
import {assert, forEachValue} from '../util'

/**
 * 模块（Modules字段）集合类
 * 虽然this.root没有写在constructor中，但是this.root指向根模块，在register()中设定
 */
export default class ModuleCollection {

  constructor(rawRootModule) {
    // register root module (Vuex.Store options)
    // 注册根模块，也就是Vuex.Store的options实参
    this.register([], rawRootModule, false)
  }

  /**
   * 从根模块开始，一层一层向内寻找一个模块
   * @param path
   * @return {*}
   */
  get(path) {
    // 用reduce来实现迭代，从根模块开始，每层父级找子级，返回子级找孙级
    return path.reduce((module, key) => {
      return module.getChild(key)
    }, this.root)
  }

  /**
   * 根据path去生成其namespace（namespaced:true 情况下用'/'分隔）
   * @param path
   * @return {*}
   */
  getNamespace(path) {
    let module = this.root
    return path.reduce((namespace, key) => {
      module = module.getChild(key)
      return namespace + (module.namespaced ? key + '/' : '')
    }, '')
  }

  /**
   * 更新模块，对this.root进行部分字段与子模块的覆盖
   * @param rawRootModule
   */
  update(rawRootModule) {
    update([], this.root, rawRootModule)
  }

  /**
   * 注册一个Module
   * @param path      对应的路径
   * @param rawModule Module的初始内容，通常是一个对象
   * @param runtime   是否在运行时注入
   */
  register(path, rawModule, runtime = true) {
    // 非生产环境下做断言检查
    if (process.env.NODE_ENV !== 'production') {
      assertRawModule(path, rawModule)
    }

    // 根据传入的Module初始内容，去创建一个改造的Module实例
    const newModule = new Module(rawModule, runtime)

    /**
     * 生成对应的path
     */
    // 空数组，说明是根模块，用this.root记录
    if (path.length === 0) {
      this.root = newModule
    }
    // 非根模块，则在它的父级上添加这个子模块
    else {
      const parent = this.get(path.slice(0, -1))
      parent.addChild(path[path.length - 1], newModule)
    }

    /**
     * 将它包含的子模块（modules字段）分别进行注册
     */
    if (rawModule.modules) {
      forEachValue(rawModule.modules, (rawChildModule, key) => {
        // 每次注册的子级path都是 ${父级path + 子级key} 的模式
        this.register(path.concat(key), rawChildModule, runtime)
      })
    }
  }

  /**
   * 注销某个模块
   * @param path
   */
  unregister(path) {
    const parent = this.get(path.slice(0, -1))
    const key = path[path.length - 1]
    // 如果不为运行时的临时模块，不予注销
    if (!parent.getChild(key).runtime) return

    parent.removeChild(key)
  }
}


/**
 * 更新某个模块，并递归更新其子模块
 * 更新方法调用Module.prototype.update()方法
 * @param path
 * @param targetModule
 * @param newModule
 */
function update(path, targetModule, newModule) {
  // 非生产环境下断言检查
  if (process.env.NODE_ENV !== 'production') {
    assertRawModule(path, newModule)
  }

  // 调用目标模块的update方法来进行更新
  targetModule.update(newModule)

  // 逐个更新子模块
  if (newModule.modules) {
    for (const key in newModule.modules) {
      if (newModule.modules.hasOwnProperty(key)) {

        // 如果有新增的子模块（原本没有的），非生产环境下提示手动重载
        if (!targetModule.getChild(key)) {
          if (process.env.NODE_ENV !== 'production') {
            console.warn(
              `[vuex] trying to add a new module '${key}' on hot reloading, ` +
              'manual reload is needed'
            )
          }
          return
        }

        // 更新子模块
        update(
          path.concat(key),
          targetModule.getChild(key),
          newModule.modules[key]
        )

      }
    }
  }
}


/**
 * 下面都是用于断言检查
 */
const functionAssert = {
  assert: value => typeof value === 'function',
  expected: 'function'
}

const objectAssert = {
  assert: value => typeof value === 'function' ||
    (typeof value === 'object' && typeof value.handler === 'function'),
  expected: 'function or object with "handler" function'
}

const assertTypes = {
  getters: functionAssert,
  mutations: functionAssert,
  actions: objectAssert
}

function assertRawModule(path, rawModule) {
  Object.keys(assertTypes).forEach(key => {
    if (!rawModule[key]) return

    const assertOptions = assertTypes[key]

    forEachValue(rawModule[key], (value, type) => {
      assert(
        assertOptions.assert(value),
        makeAssertionMessage(path, key, type, value, assertOptions.expected)
      )
    })
  })
}

function makeAssertionMessage(path, key, type, value, expected) {
  let buf = `${key} should be ${expected} but "${key}.${type}"`
  if (path.length > 0) {
    buf += ` in module "${path.join('.')}"`
  }
  buf += ` is ${JSON.stringify(value)}.`
  return buf
}
