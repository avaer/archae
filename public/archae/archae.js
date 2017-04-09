const RECONNECT_TIMEOUT = 2 * 1000;

// begin inline

class MultiMutex {
  constructor() {
    this.mutexes = new Map();
  }

  lock(key, options) {
    let mutex = this.mutexes.get(key);
    if (!mutex) {
      mutex = new Mutex(key, this);
      this.mutexes.set(key, mutex);
    }

    return mutex.lock(options);
  }

  remove(key) {
    this.mutexes.delete(key);
  }
}

class Mutex {
  constructor(key, parent) {
    this._key = key;
    this._parent = parent;

    this.locked = false;
    this.queue = [];
  }

  lock(options = {}) {
    return new Promise((accept, reject) => {
      let timeout = options.timeout ? setTimeout(() => {
        this.queue.splice(this.queue.indexOf(_tryLock), 1);

        const err = new Error('mutex lock request timed out');
        reject(err);
      }, options.timeout) : null;

      const _tryLock = () => {
        if (!this.locked) {
          this.locked = true;

          if (timeout) {
            clearTimeout(timeout);
            timeout = null;
          }

          accept(() => {
            this.unlock();
          });
        } else {
          this.queue.push(_tryLock);
        }
      };
      _tryLock();
    });
  }

  unlock() {
    this.locked = false;

    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this._parent.remove(this._key);
    }
  }
}

// end inline

const pathSymbol = Symbol();
const nameSymbol = Symbol();

class ArchaeClient {
  constructor() {
    this.metadata = null;

    this.plugins = {};
    this.pluginInstances = {};
    this.pluginApis = {};
    this.loadsMutex = new MultiMutex();
    this.mountsMutex = new MultiMutex();

    this._connection = null;
    this._lastConnectTime = -Infinity;
    this._reconnectTimeout = null;
    this._queue = [];
    this._messageListeners = [];
    this._listeners = {};

    this.connect();
  }

  requestPlugin(plugin) {
    return this.requestPlugins([plugin])
      .then(([plugin]) => Promise.resolve(plugin));
  }

  requestPlugins(plugins) {
    return new Promise((accept, reject) => {
      const cb = (err, result) => {
        if (!err) {
          accept(result);
        } else {
          reject(err);
        }
      };

      const _emitPluginLoadStart = () => new Promise((accept, reject) => {
        for (let i = 0; i < plugins.length; i++) {
          const plugin = plugins[i];
          this.emit('pluginloadstart', plugin);
        }

        accept();
      });
      const _requestPluginsRemote = plugins => new Promise((accept, reject) => {
        this.request('requestPlugins', {
          plugins,
        }, (err, pluginSpecs) => {
          if (!err) {
            accept(pluginSpecs);
          } else {
            reject(err);
          }
        });
      });
      const _bootPlugins = pluginSpecs => Promise.all(pluginSpecs.map((pluginSpec, index) => new Promise((accept, reject) => {
        const cb = (err, result) => {
          if (!err) {
            accept(result);
          } else {
            reject(err);
          }
        };

        const {plugin, pluginName, hasClient} = pluginSpec;
        const pluginInstance = plugins[index];

        const _loadPlugin = cb => {
          if (hasClient) {
            this.loadsMutex.lock(pluginName)
              .then(unlock => {
                this.loadPlugin(pluginName, err => {
                  cb(err);

                  this.emit('pluginload', pluginInstance);

                  unlock();
                });
              })
              .catch(err => {
                cb(err);
              });
          } else {
            cb();
          }
        };

        _loadPlugin(err => {
          if (!err) {
            this.mountsMutex.lock(pluginName)
              .then(unlock => {
                this.mountPlugin(plugin, pluginName, err => {
                  if (!err) {
                    cb(null, this.pluginApis[pluginName]);
                  } else {
                    cb(err);
                  }

                  unlock();
                });
              })
              .catch(err => {
                cb(err);
              });
          } else {
            cb(err);
          }
        });
      })));

      _emitPluginLoadStart()
        .then(() => _requestPluginsRemote(plugins))
        .then(pluginSpecs => _bootPlugins(pluginSpecs)
          .then(pluginApis => {
            cb(null, pluginApis);
          })
        )
        .catch(err => {
          cb(err);
        });
    });
  }

  releasePlugin(plugin) {
    return new Promise((accept, reject) => {
      this.request('releasePlugin', {
        plugin,
      }, (err, result) => {
        if (!err) {
          const {plugin, pluginName} = result;
          const oldPluginApi = this.pluginApis[pluginName];

          this.mountsMutex.lock(pluginName)
            .then(unlock => {
              this.unmountPlugin(plugin, pluginName, err => {
                if (err) {
                  console.warn(err);
                }

                this.unloadPlugin(pluginName);

                accept(oldPluginApi);

                unlock();
              });
            })
            .catch(err => {
              reject(err);
            });
        } else {
          reject(err);
        }
      });
    });
  }

  releasePlugins(plugins) {
    const releasePluginPromises = plugins.map(plugin => this.releasePlugin(plugin));
    return Promise.all(releasePluginPromises);
  }

  requestWorker(moduleInstance, {count = 1} = {}) {
    const responseListeners = new Map();
    const onmessage = e => {
      const {onmessage: fakeWorkerOnMessage} = fakeWorker;

      if (fakeWorkerOnMessage) {
        fakeWorkerOnMessage(e);
      } else {
        const {data} = e;
        if (data && typeof data == 'object' && !Array.isArray(data)) {
          const {id} = data;

          if (typeof id === 'string') {
            const responseListener = responseListeners.get(id);

            if (responseListener) {
              const {error, result} = data;
              responseListener(error, result);

              responseListeners.delete(id);
            }
          }
        }
      }
    };
    const onerror = err => {
      console.warn(err);
    };
    const workers = (() => {
      const result = [];
      const moduleName = moduleInstance[nameSymbol];
      for (let i = 0; i < count; i++) {
        const worker = new Worker('/archae/worker.js');
        worker.postMessage({
          method: 'init',
          args: [ 'plugins', moduleName, moduleName + '-worker' ],
        });
        worker.onmessage = onmessage;
        worker.onerror = onerror;
        result.push(worker);
      }
      return result;
    })();

    let workerIndex = 0;
    const _getNextWorker = () => {
      const worker = workers[workerIndex];
      workerIndex = (workerIndex + 1) % count;
      return worker;
    }

    const fakeWorker = {
      postMessage(m, transfers) {
        _getNextWorker().postMessage(m, transfers);
      },
      terminate() {
        for (let i = 0; i < count; i++) {
          const worker = workers[i];
          worker.terminate();
        }
      },
      onmessage: null,
      request(method, args = [], transfers) {
        return new Promise((accept, reject) => {
          const id = _makeId();

          _getNextWorker().postMessage({
            method,
            args,
            id,
          }, transfers);

          responseListeners.set(id, (err, result) => {
            if (!err) {
              accept(result);
            } else {
              reject(err);
            }
          });
        });
      },
    };
    return Promise.resolve(fakeWorker);
  }

  loadPlugin(plugin, cb) {
    const existingPlugin = this.plugins[plugin];

    if (existingPlugin !== undefined) {
      cb();
    } else {
      window.module = {};

      _loadScript('/archae/plugins/' + plugin + '/' + plugin + '.js')
        .then(() => {
          this.plugins[plugin] = window.module.exports;

          window.module = {};

          cb();
        })
        .catch(err => {
          cb(err);
        });
    }
  }

  unloadPlugin(pluginName) {
    delete this.plugins[pluginName];
  }

  mountPlugin(plugin, pluginName, cb) {
    const existingPluginApi = this.pluginApis[pluginName];

    if (existingPluginApi !== undefined) {
      cb();
    } else {
      const moduleRequire = this.plugins[pluginName];

      if (moduleRequire) {
        Promise.resolve(_instantiate(moduleRequire, this))
          .then(pluginInstance => {
            pluginInstance[pathSymbol] = plugin;
            pluginInstance[nameSymbol] = pluginName;
            this.pluginInstances[pluginName] = pluginInstance;

            Promise.resolve(pluginInstance.mount())
              .then(pluginApi => {
                if (typeof pluginApi !== 'object' || pluginApi === null) {
                  pluginApi = {};
                }
                pluginApi[pathSymbol] = plugin;
                pluginApi[nameSymbol] = pluginName;

                this.pluginApis[pluginName] = pluginApi;

                cb();
              })
              .catch(err => {
                cb(err);
              });
          })
          .catch(err => {
            cb(err);
          });
      } else {
        this.pluginInstances[pluginName] = null;
        this.pluginApis[pluginName] = {
          [pathSymbol]: plugin,
          [nameSymbol]: pluginName,
        };

        cb();
      }
    }
  }

  unmountPlugin(plugin, pluginName, cb) {
    const pluginInstance = this.pluginInstances[pluginName];

    if (pluginInstance !== undefined) {
      Promise.resolve(typeof pluginInstance.unmount === 'function' ? pluginInstance.unmount() : null)
        .then(() => {
          delete this.pluginInstances[pluginName];
          delete this.pluginApis[pluginName];

          cb();
        })
        .catch(err => {
          cb(err);
        });
    } else {
      cb();
    }
  }

  getCore() {
    return {};
  }

  getPath(moduleApi) {
    return moduleApi ? moduleApi[pathSymbol] : null;
  }

  getName(moduleApi) {
    return moduleApi ? moduleApi[nameSymbol] : null;
  }

  connect() {
    const connection = (() => {
      const result = new WebSocket('wss://' + location.host + '/archae/ws');
      result.onopen = () => {
        console.log('connection opened');

        this._connection = connection;

        if (this._queue.length > 0) {
          for (let i = 0; i < this._queue.length; i++) {
            this.send(this._queue[i]);
          }
          this._queue.length = 0;
        }
      };
      const _cleanup = () => {
        if (this._connection === connection) {
          if (this._messageListeners.length > 0) {
            const globalErrorMessage = {
              globalError: new Error('connection closed'),
            };
            for (let i = 0; i < this._messageListeners.length; i++) {
              const listener = this._messageListeners[i];
              listener(globalErrorMessage);
            }
          }

          this._connection = null;
        }
      };
      result.onclose = () => {
        console.log('connection closed');

        _cleanup();

        this.reconnect();
      };
      result.onerror = err => {
        console.warn(err);

        _cleanup();

        this.reconnect();
      };
      result.onmessage = msg => {
        const m = JSON.parse(msg.data);

        for (let i = 0; i < this._messageListeners.length; i++) {
          const listener = this._messageListeners[i];
          listener(m);
        }
      };
      return result;
    })();
    this._lastConnectTime = Date.now();

    this.onceMessageType('init', (err, result) => {
      if (!err) {
        const {metadata} = result;

        this.metadata = metadata;
      } else {
        console.warn(err);
      }
    });
  }

  reconnect() {
    if (this._reconnectTimeout) {
      clearTimeout(this._reconnectTimeout);
    }

    const {_lastConnectTime: lastConnectTime} = this;
    const now = Date.now();
    const timeDiff = now - lastConnectTime;

    if (timeDiff > RECONNECT_TIMEOUT) {
      this.connect();
    } else {
      this._reconnectTimeout = setTimeout(() => {
        clearTimeout(this._reconnectTimeout);

        this.reconnect();
      }, RECONNECT_TIMEOUT - timeDiff);
    }
  }

  request(method, args, cb) {
    const id = _makeId();

    this.send({
      method,
      args,
      id: id,
    });

    this.onceMessageId(id, (err, result) => {
      if (!err) {
        cb(null, result);
      } else {
        cb(err);
      }
    });
  }

  send(o) {
    if (this._connection && this._connection.readyState === WebSocket.OPEN) {
      this._connection.send(JSON.stringify(o));
    } else {
      this._queue.push(o);
    }
  }

  onceMessageType(type, handler) {
    const listener = m => {
      if (m.type === type) {
        handler(m.error, m.result);

        this._messageListeners.splice(this._messageListeners.indexOf(listener), 1);
      } else if (m.globalError) {
        handler(m.globalError);

        this._messageListeners.splice(this._messageListeners.indexOf(listener), 1);
      }
    };
    this._messageListeners.push(listener);
  }

  onceMessageId(id, handler) {
    const listener = m => {
      if (m.id === id) {
        handler(m.error, m.result);

        this._messageListeners.splice(this._messageListeners.indexOf(listener), 1);
      } else if (m.globalError) {
        handler(m.globalError);

        this._messageListeners.splice(this._messageListeners.indexOf(listener), 1);
      }
    };
    this._messageListeners.push(listener);
  }

  on(event, handler) {
    let listeners = this._listeners[event];
    if (!listeners) {
      listeners = [];
      this._listeners[event] = listeners;
    }
    listeners.push(handler);
  }

  removeListener(event, handler) {
    const listeners = this._listeners[event];

    if (listeners) {
      const index = listeners.indexOf(handler);

      if (index !== -1) {
        listeners.splice(index, 1);

        if (listeners.length === 0) {
          this._listeners[event] = null;
        }
      }
    }
  }

  emit(event, data) {
    const listeners = this._listeners[event];

    if (listeners) {
      for (let i = 0; i < listeners.length; i++) {
        const listener = listeners[i];
        listener(data);
      }
    }
  }
}

const _instantiate = (o, arg) => {
  if (typeof o === 'function') {
    if (/^(?:function|class|constructor)/.test(o.toString())) {
      return new o(arg);
    } else {
      return o(arg);
    }
  } else {
    return o;
  }
};
const _isConstructible = fn => typeof fn === 'function' && /^(?:function|class)/.test(fn.toString());

const _makeId = () => Math.random().toString(36).substring(7);

const _loadScript = src => new Promise((accept, reject) => {
  const script = document.createElement('script');
  script.src = src;
  script.async = true;
  script.onload = () => {
    accept();
    _cleanup();
  };
  script.onerror = err => {
    reject(err);
    _cleanup();
  };
  document.body.appendChild(script);

  const _cleanup = () => {
    document.body.removeChild(script);
  };
});
const _asyncEval = s => new Promise((accept, reject) => {
  let error = null;
  try {
    eval(s);
  } catch(err) {
    error = err;
  }

  if (!error) {
    accept();
  } else {
    reject(error);
  }
});

const archae = new ArchaeClient();
window.archae = archae;
