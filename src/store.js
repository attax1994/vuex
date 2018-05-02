import applyMixin from './mixin'
import devtoolPlugin from './plugins/devtool'
import ModuleCollection from './module/module-collection'
import {forEachValue, isObject, isPromise, assert} from './util'

let Vue // bind on install

export class Store {
  constructor(options = {}) {
    // Auto install if it is not done yet and `window` has `Vue`.
    // To allow users to avoid auto-installation in some cases,
    // this code should be placed here. See #731
    // 如果没有运行Vue.install(Vuex)，但是window下已经有Vue全局对象，就需要先安装
    if (!Vue && typeof window !== 'undefined' && window.Vue) {
      install(window.Vue)
    }

    /**
     * 非生产环境的断言
     */
    if (process.env.NODE_ENV !== 'production') {
      // new Store()前要Vue.use(Vuex)
      assert(Vue, `must call Vue.use(Vuex) before creating a store instance.`)
      // 检查浏览器是否支持Promise
      assert(typeof Promise !== 'undefined', `vuex requires a Promise polyfill in this browser.`)
      // 检查是否使用new操作符去创建实例
      assert(this instanceof Store, `store must be called with the new operator.`)
    }

    // plugins和strict是从options中解构得到
    const {
      plugins = [],
      strict = false
    } = options

    /**
     * store的内部状态变量(模拟private)
     */
    this._committing = false
    // 全空的对象，没有__proto__，通常用来做字典
    this._actions = Object.create(null)
    this._actionSubscribers = []
    this._mutations = Object.create(null)
    this._wrappedGetters = Object.create(null)
    // modules集合，进行整体的模块管理
    this._modules = new ModuleCollection(options)
    // module的命名空间(namespace)字典
    this._modulesNamespaceMap = Object.create(null)
    this._subscribers = []
    // 用一个Vue实例来进行变量的监测
    this._watcherVM = new Vue()

    /**
     * 对默认的dispatch和commit做一层闭包，执行的时候自动传入store自身，传参时候只需要传后面几个参数
     */
    const store = this
    const {dispatch, commit} = this
    this.dispatch = function boundDispatch(type, payload) {
      return dispatch.call(store, type, payload)
    }
    this.commit = function boundCommit(type, payload, options) {
      return commit.call(store, type, payload, options)
    }

    /**
     * 是否为严格模式，strict从实参options中解构得到
     * @type {boolean}
     */
    this.strict = strict

    const state = this._modules.root.state

    // init root module.
    // this also recursively registers all sub-modules
    // and collects all module getters inside this._wrappedGetters
    /**
     * 初始化根模块，
     * 同时递归注册所有子模块，
     * 并且将所有模块的getters收集到this._wrappedGetters
     */
    installModule(this, state, [], this._modules.root)

    // 初始化store的vm，用于控制数据的自动更新，同时也将_wrappedGetters注册为它的computed属性
    resetStoreVM(this, state)

    // 导入插件
    plugins.forEach(plugin => plugin(this))

    if (Vue.config.devtools) {
      devtoolPlugin(this)
    }
  }

  get state() {
    return this._vm._data.$$state
  }

  set state(v) {
    if (process.env.NODE_ENV !== 'production') {
      assert(false, `use store.replaceState() to explicit replace store state.`)
    }
  }

  /**
   * 执行一个mutation，可以传入type、payload、options，或是对象型参数
   * @param _type
   * @param _payload
   * @param _options
   */
  commit(_type, _payload, _options) {
    // 参数规整（主要针对传入对象的情况）
    const {
      type,
      payload,
      options
    } = unifyObjectStyle(_type, _payload, _options)

    const mutation = {type, payload}
    // 找到this._mutations中对应的类型
    const entry = this._mutations[type]

    // mutation类型不存在时的异常处理
    if (!entry) {
      if (process.env.NODE_ENV !== 'production') {
        console.error(`[vuex] unknown mutation type: ${type}`)
      }
      return
    }

    // 传参执行
    this._withCommit(() => {
      entry.forEach(function commitIterator(handler) {
        handler(payload)
      })
    })
    // 触发订阅者的更新
    this._subscribers.forEach(sub => sub(mutation, this.state))

    if (
      process.env.NODE_ENV !== 'production' &&
      options && options.silent
    ) {
      console.warn(
        `[vuex] mutation type: ${type}. Silent option has been removed. ` +
        'Use the filter functionality in the vue-devtools'
      )
    }
  }

  /**
   * 执行一个action，可以传入type、payload，或是对象型参数
   * @param _type
   * @param _payload
   * @return {*}
   */
  dispatch(_type, _payload) {
    // 参数规整（主要针对传入对象的情况）
    const {
      type,
      payload
    } = unifyObjectStyle(_type, _payload)

    const action = {type, payload}
    const entry = this._actions[type]
    if (!entry) {
      if (process.env.NODE_ENV !== 'production') {
        console.error(`[vuex] unknown action type: ${type}`)
      }
      return
    }

    // 触发订阅者的更新
    this._actionSubscribers.forEach(sub => sub(action, this.state))

    // 如果有多个，使用Promise.all()方法异步执行
    return entry.length > 1
      ? Promise.all(entry.map(handler => handler(payload)))
      : entry[0](payload)
  }

  /**
   * 给mutations添加订阅者，参考下方的genericSubscribe()函数
   * @param fn
   * @return {*}
   */
  subscribe(fn) {
    return genericSubscribe(fn, this._subscribers)
  }

  /**
   * 给actions添加订阅者，参考下方的genericSubscribe()函数
   * @param fn
   * @return {*}
   */
  subscribeAction(fn) {
    return genericSubscribe(fn, this._actionSubscribers)
  }

  /**
   * 使用Vue实例来监测某个变量，并设置回调
   * @param getter
   * @param cb
   * @param options
   * @return {*}
   */
  watch(getter, cb, options) {
    if (process.env.NODE_ENV !== 'production') {
      assert(typeof getter === 'function', `store.watch only accepts a function.`)
    }
    return this._watcherVM.$watch(() => getter(this.state, this.getters), cb, options)
  }

  /**
   * state的显式set()
   * @param state
   */
  replaceState(state) {
    this._withCommit(() => {
      this._vm._data.$$state = state
    })
  }

  /**
   * 手动注册一个模块
   * @param path
   * @param rawModule
   * @param options
   */
  registerModule(path, rawModule, options = {}) {
    if (typeof path === 'string') path = [path]

    if (process.env.NODE_ENV !== 'production') {
      assert(Array.isArray(path), `module path must be a string or an Array.`)
      assert(path.length > 0, 'cannot register the root module by using registerModule.')
    }

    this._modules.register(path, rawModule)
    installModule(this, this.state, path, this._modules.get(path), options.preserveState)
    // 重置Vue实例，更新getters
    resetStoreVM(this, this.state)
  }

  /**
   * 手动注销一个模块
   * @param path
   */
  unregisterModule(path) {
    if (typeof path === 'string') path = [path]

    if (process.env.NODE_ENV !== 'production') {
      assert(Array.isArray(path), `module path must be a string or an Array.`)
    }

    // 从this._modules中移除
    this._modules.unregister(path)
    // 移除在Vue实例中的相关监测
    this._withCommit(() => {
      const parentState = getNestedState(this.state, path.slice(0, -1))
      Vue.delete(parentState, path[path.length - 1])
    })
    // 初始化整个store
    resetStore(this)
  }

  /**
   * 热更新，即更新完成后重置store
   * @param newOptions
   */
  hotUpdate(newOptions) {
    this._modules.update(newOptions)
    resetStore(this, true)
  }

  /**
   * 进行操作的同时，置位this._committing，结束后this._committing恢复到原来的状态
   * @param fn
   * @private
   */
  _withCommit(fn) {
    const committing = this._committing
    this._committing = true
    fn()
    this._committing = committing
  }
}

/**
 * 生成一次订阅
 * @param fn
 * @param subs
 * @return {Function}
 */
function genericSubscribe(fn, subs) {
  // 如果传入的fn还没有加入订阅，就将其加入
  if (subs.indexOf(fn) < 0) {
    subs.push(fn)
  }
  // 返回的闭包用于解除订阅
  return () => {
    const i = subs.indexOf(fn)
    if (i > -1) {
      subs.splice(i, 1)
    }
  }
}

/**
 * 重置store
 * @param store
 * @param hot
 */
function resetStore(store, hot) {
  // 全部初始化为空对象
  store._actions = Object.create(null)
  store._mutations = Object.create(null)
  store._wrappedGetters = Object.create(null)
  store._modulesNamespaceMap = Object.create(null)
  const state = store.state
  // 初始化所有模块
  installModule(store, state, [], store._modules.root, true)
  // 重置Vue实例
  resetStoreVM(store, state, hot)
}

/**
 * 生成一个新的vm来监测state，并销毁旧的vm
 * @param store
 * @param state
 * @param hot
 */
function resetStoreVM(store, state, hot) {
  const oldVm = store._vm

  // bind store public getters
  // 绑定store的公共getters
  store.getters = {}
  const wrappedGetters = store._wrappedGetters

  // 使用computed来触发懒缓存机制，后面要将其作为Vue实例的computed属性
  const computed = {}
  forEachValue(wrappedGetters, (fn, key) => {
    computed[key] = () => fn(store)
    Object.defineProperty(store.getters, key, {
      // 改造get()，采用vm的机制
      get: () => store._vm[key],
      enumerable: true // for local getters
    })
  })

  // use a Vue instance to store the state tree
  // suppress warnings just in case the user has added
  // some funky global mixins
  /**
   * 使用一个Vue实例来存储state树
   * 使用silent模式，即使用户做了一些不恰当的全局混入，也不弹出warning
   */
  const silent = Vue.config.silent
  Vue.config.silent = true
  store._vm = new Vue({
    data: {
      $$state: state
    },
    computed
  })
  Vue.config.silent = silent

  // 判断是否设置严格模式
  if (store.strict) {
    enableStrictMode(store)
  }

  // 如果原来的vm存在，并且开启了热切换，就销毁原来的vm
  if (oldVm) {
    if (hot) {
      // dispatch changes in all subscribed watchers
      // to force getter re-evaluation for hot reloading.
      store._withCommit(() => {
        oldVm._data.$$state = null
      })
    }
    Vue.nextTick(() => oldVm.$destroy())
  }
}

/**
 * 安装一个模块，同时也会递归注册子模块，
 * 并且将所有模块的getters收集到store._wrappedGetters
 * @param store       操作的目标store
 * @param rootState   根模块的state
 * @param path        路径
 * @param module      安装的模块对象
 * @param hot
 */
function installModule(store, rootState, path, module, hot) {
  // path空数组，表示为根模块，否则为子模块
  const isRoot = !path.length
  // 生成namespace
  const namespace = store._modules.getNamespace(path)

  // 在_modulesNamespaceMap字典中记录该模块
  if (module.namespaced) {
    store._modulesNamespaceMap[namespace] = module
  }

  // 设置state
  if (!isRoot && !hot) {
    const parentState = getNestedState(rootState, path.slice(0, -1))
    const moduleName = path[path.length - 1]
    // 操作完成前，置位store._committing，完成后恢复
    store._withCommit(() => {
      Vue.set(parentState, moduleName, module.state)
    })
  }

  // 设置每个module的本地上下文
  const local = module.context = makeLocalContext(store, namespace, path)

  /**
   * 对mutations, actions和getter字段分别注册
   */
  module.forEachMutation((mutation, key) => {
    const namespacedType = namespace + key
    registerMutation(store, namespacedType, mutation, local)
  })

  module.forEachAction((action, key) => {
    const type = action.root ? key : namespace + key
    const handler = action.handler || action
    registerAction(store, type, handler, local)
  })

  module.forEachGetter((getter, key) => {
    const namespacedType = namespace + key
    registerGetter(store, namespacedType, getter, local)
  })

  // 递归安装每个子模块
  module.forEachChild((child, key) => {
    installModule(store, rootState, path.concat(key), child, hot)
  })
}

/**
 * make localized dispatch, commit, getters and state
 * if there is no namespace, just use root ones
 * 给module设置自身的dispatch, commit, getters和state
 * 对于没有namespace的模块，使用根模块的对应属性
 */
function makeLocalContext(store, namespace, path) {
  // 判断是否有自身的namespace，有的话就要创建其自身的dispatch, commit, getters和state
  const noNamespace = namespace === ''

  const local = {
    dispatch: noNamespace ? store.dispatch : (_type, _payload, _options) => {
      // 参数规整
      const args = unifyObjectStyle(_type, _payload, _options)
      const {payload, options} = args
      let {type} = args

      // 如果没传入options或者options.root不为true，则type使用带namespace前缀的类型
      if (!options || !options.root) {
        type = namespace + type
        if (process.env.NODE_ENV !== 'production' && !store._actions[type]) {
          console.error(`[vuex] unknown local action type: ${args.type}, global type: ${type}`)
          return
        }
      }

      // 规整完后再调用根模块的dispatch方法，传入改造后的参数
      return store.dispatch(type, payload)
    },

    commit: noNamespace ? store.commit : (_type, _payload, _options) => {
      const args = unifyObjectStyle(_type, _payload, _options)
      const {payload, options} = args
      let {type} = args

      if (!options || !options.root) {
        type = namespace + type
        if (process.env.NODE_ENV !== 'production' && !store._mutations[type]) {
          console.error(`[vuex] unknown local mutation type: ${args.type}, global type: ${type}`)
          return
        }
      }

      store.commit(type, payload, options)
    }
  }

  /**
   * getters和state对象需要懒获取，
   * 但是Vue实例会改造其PropertyDescriptor，
   * 所以要对它们的get方法重新进行改造
   */
  Object.defineProperties(local, {
    getters: {
      get: noNamespace
        ? () => store.getters
        : () => makeLocalGetters(store, namespace)
    },
    state: {
      get: () => getNestedState(store.state, path)
    }
  })

  return local
}

/**
 * 对namespaced的模块生成本地的getters
 * @param store
 * @param namespace
 */
function makeLocalGetters(store, namespace) {
  const gettersProxy = {}

  // 用namespace的长度作为分割点的位置索引
  const splitPos = namespace.length
  // 遍历getter
  Object.keys(store.getters).forEach(type => {
    // 判断这个getter的namespace，如果不是目标module的namespace，说明不属于这个module，跳过
    if (type.slice(0, splitPos) !== namespace) return

    // 对于属于这个module的getter，去掉前缀的namespace，保留基本的名称
    const localType = type.slice(splitPos)

    /**
     * 将符合的getter，加入gettersProxy，改造其get()为返回根模块下对应getter
     */
    Object.defineProperty(gettersProxy, localType, {
      get: () => store.getters[type],
      enumerable: true
    })
  })

  return gettersProxy
}

/**
 * 注册一个mutation
 * @param store
 * @param type
 * @param handler
 * @param local
 */
function registerMutation(store, type, handler, local) {
  // 找到它对应的type，如果为undefined就初始化一个空数组
  const entry = store._mutations[type] || (store._mutations[type] = [])
  // 将其push进这个数组，注意传入的实参是store, local.state和payload
  entry.push(function wrappedMutationHandler(payload) {
    handler.call(store, local.state, payload)
  })
}

/**
 * 注册一个action
 * @param store
 * @param type
 * @param handler
 * @param local
 */
function registerAction(store, type, handler, local) {
  const entry = store._actions[type] || (store._actions[type] = [])
  entry.push(function wrappedActionHandler(payload, cb) {
    let res = handler.call(store, {
      dispatch: local.dispatch,
      commit: local.commit,
      getters: local.getters,
      state: local.state,
      rootGetters: store.getters,
      rootState: store.state
    }, payload, cb)

    /**
     * action考虑了用Promise做异步处理的情况，对其进行resolve
     */
    if (!isPromise(res)) {
      res = Promise.resolve(res)
    }

    if (store._devtoolHook) {
      return res.catch(err => {
        store._devtoolHook.emit('vuex:error', err)
        throw err
      })
    } else {
      return res
    }
  })
}

/**
 * 注册一个getter
 * @param store
 * @param type
 * @param rawGetter
 * @param local
 */
function registerGetter(store, type, rawGetter, local) {
  // 防止相同键的覆盖
  if (store._wrappedGetters[type]) {
    if (process.env.NODE_ENV !== 'production') {
      console.error(`[vuex] duplicate getter key: ${type}`)
    }
    return
  }

  store._wrappedGetters[type] = function wrappedGetter(store) {
    return rawGetter(
      local.state, // local state
      local.getters, // local getters
      store.state, // root state
      store.getters // root getters
    )
  }
}

/**
 * 对管理State的vm使用严格模式
 * @param store
 */
function enableStrictMode(store) {
  store._vm.$watch(function () {
    return this._data.$$state
  }, () => {
    if (process.env.NODE_ENV !== 'production') {
      assert(store._committing, `do not mutate vuex store state outside mutation handlers.`)
    }
  }, {deep: true, sync: true})
}

/**
 * 返回用path逐层包裹下的state
 * @param state
 * @param path
 * @return {*}
 */
function getNestedState(state, path) {
  return path.length
    ? path.reduce((state, key) => state[key], state)
    : state
}

/**
 * 对不符合标准API的对象进行转换
 * @param type
 * @param payload
 * @param options
 * @return {{type: *, payload: *, options: *}}
 */
function unifyObjectStyle(type, payload, options) {
  // 如果传入的是对象，要进行额外的规整
  if (isObject(type) && type.type) {
    options = payload
    payload = type
    type = type.type
  }

  if (process.env.NODE_ENV !== 'production') {
    assert(typeof type === 'string', `expects string as the type, but found ${typeof type}.`)
  }

  return {type, payload, options}
}


/**
 * 暴露给Vue.use()用的installer
 */
export function install(_Vue) {
  if (Vue && _Vue === Vue) {
    if (process.env.NODE_ENV !== 'production') {
      console.error(
        '[vuex] already installed. Vue.use(Vuex) should be called only once.'
      )
    }
    return
  }
  Vue = _Vue
  applyMixin(Vue)
}
