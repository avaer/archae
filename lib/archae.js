const events = require('events');
const {EventEmitter} = events;
const MultiMutex = require('multimutex');
const AutoWs = require('autows');

const pathSymbol = Symbol();
const nameSymbol = Symbol();

class ArchaeClient extends EventEmitter {
  constructor() {
    super();

    this.metadata = null;

    this.plugins = {};
    this.pluginInstances = {};
    this.pluginApis = {};
    this.loadsMutex = new MultiMutex();
    this.mountsMutex = new MultiMutex();

    this._connection = null;
    this._messageListeners = [];

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

  releasePlugin(plugin, pluginName) {
    return new Promise((accept, reject) => {
      this.mountsMutex.lock(pluginName)
        .then(unlock => new Promise((accept, reject) => {
          this.unmountPlugin(plugin, pluginName, err => {
            if (err) {
              console.warn(err);
            }

            this.unloadPlugin(pluginName);

            accept();

            unlock();
          });
        }))
        .then(accept)
        .catch(reject);
    });
  }

  releasePlugins(plugins) {
    const releasePluginPromises = plugins.map(plugin => this.releasePlugin(plugin));
    return Promise.all(releasePluginPromises);
  }

  removePlugin(plugin) {
    return new Promise((accept, reject) => {
      this.request('removePlugin', {
        plugin,
      }, (err, result) => {
        if (!err) {
          const {plugin, pluginName} = result;
          const oldPluginApi = this.pluginApis[pluginName];

          this.releasePlugin(plugin, pluginName)
            .then(() => {
              accept(oldPluginApi);
            })
            .catch(reject);
        } else {
          reject(err);
        }
      });
    });
  }

  removePlugins(plugins) {
    const removePluginPromises = plugins.map(plugin => this.removePlugin(plugin));
    return Promise.all(removePluginPromises);
  }

  loadPlugin(plugin, cb) {
    const existingPlugin = this.plugins[plugin];

    if (existingPlugin !== undefined) {
      cb();
    } else {
      window.module = {};

      _loadScript('archae/plugins/' + plugin + '/' + plugin + '.js')
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
    const connection = new AutoWs(_relativeWsUrl('archae/ws'));
    connection.on('connect', () => {
      this.onceMessageType('init', (err, result) => {
        if (!err) {
          const {metadata} = result;

          this.metadata = metadata;
        } else {
          console.warn(err);
        }
      });
    });
    connection.on('disconnect', () => {
      const globalErrorMessage = {
        globalError: new Error('connection closed'),
      };
      for (let i = 0; i < this._messageListeners.length; i++) {
        const listener = this._messageListeners[i];
        listener(globalErrorMessage);
      }
    });
    connection.on('message', msg => {
      const m = JSON.parse(msg.data);

      for (let i = 0; i < this._messageListeners.length; i++) {
        const messageListener = this._messageListeners[i];
        messageListener(m);
      }
    });
    this._connection = connection;
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
    this._connection.send(JSON.stringify(o));
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
}

const _relativeWsUrl = s => {
  const l = window.location;
  return ((l.protocol === 'https:') ? 'wss://' : 'ws://') + l.host + l.pathname + (!/\/$/.test(l.pathname) ? '/' : '') + s;
};

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

const archae = new ArchaeClient();
window.archae = archae;

if (typeof window.module === 'undefined') {
  window.module = {};
}

module.exports = archae;
