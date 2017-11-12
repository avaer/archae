const events = require('events');
const {EventEmitter} = events;
const MultiMutex = require('multimutex');
const AutoWs = require('autows');

const pathSymbol = Symbol();

(window => {

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

  requestPlugin(plugin, {force = false, hotload = false} = {}) {
    return this.requestPlugins([plugin], {force, hotload})
      .then(([plugin]) => Promise.resolve(plugin));
  }

  requestPlugins(plugins, {force = false, hotload = false} = {}) {
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
          force,
          hotload,
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

        const {plugin, hasClient} = pluginSpec;
        const pluginInstance = plugins[index];

        const _loadPlugin = cb => {
          if (hasClient) {
            this.loadsMutex.lock(plugin)
              .then(unlock => {
                this.loadPlugin(plugin, err => {
                  cb(err);

                  this.emit('pluginload', pluginInstance);

                  unlock();
                });
              })
              .catch(err => {
                this.emit('pluginload', pluginInstance);

                cb(err);
              });
          } else {
            this.emit('pluginload', pluginInstance);

            cb();
          }
        };

        _loadPlugin(err => {
          if (!err) {
            this.mountsMutex.lock(plugin)
              .then(unlock => {
                this.mountPlugin(plugin, err => {
                  if (!err) {
                    cb(null, this.pluginApis[plugin]);
                  } else {
                    cb(err);
                  }

                  this.emit('pluginmount', pluginInstance);

                  unlock();
                });
              })
              .catch(err => {
                this.emit('pluginmount', pluginInstance);

                cb(err);
              });
          } else {
            this.emit('pluginmount', pluginInstance);

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
      this.mountsMutex.lock(plugin)
        .then(unlock => new Promise((accept, reject) => {
          this.unmountPlugin(plugin, err => {
            if (err) {
              console.warn(err);
            }

            this.unloadPlugin(plugin);

            accept();

            unlock();
          });
        }))
        .then(accept)
        .catch(reject);
    });
  }

  releasePlugins(plugins) {
    return Promise.all(plugins.map(plugin => this.releasePlugin(plugin)));
  }

  removePlugin(plugin) {
    return new Promise((accept, reject) => {
      this.request('removePlugin', {
        plugin,
      }, err => {
        if (!err) {
          const oldPluginApi = this.pluginApis[plugin];

          this.releasePlugin(plugin)
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

      const pluginFileName = /^\//.test(plugin) ? plugin.replace(/\//g, '_') : plugin;
      _loadScript('archae/plugins/' + pluginFileName + '/' + pluginFileName + '.js')
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

  unloadPlugin(plugin) {
    delete this.plugins[plugin];
  }

  mountPlugin(plugin, cb) {
    const existingPluginApi = this.pluginApis[plugin];

    if (existingPluginApi !== undefined) {
      cb();
    } else {
      const moduleRequire = this.plugins[plugin];

      if (moduleRequire) {
        Promise.resolve(_instantiate(moduleRequire, this))
          .then(pluginInstance => {
            pluginInstance[pathSymbol] = plugin;
            this.pluginInstances[plugin] = pluginInstance;

            Promise.resolve(pluginInstance.mount())
              .then(pluginApi => {
                if (typeof pluginApi !== 'object' || pluginApi === null) {
                  pluginApi = {};
                }
                pluginApi[pathSymbol] = plugin;

                this.pluginApis[plugin] = pluginApi;

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
        this.pluginInstances[plugin] = null;
        this.pluginApis[plugin] = {
          [pathSymbol]: plugin,
        };

        cb();
      }
    }
  }

  unmountPlugin(plugin, cb) {
    const pluginInstance = this.pluginInstances[plugin];

    if (pluginInstance !== undefined) {
      Promise.resolve(typeof pluginInstance.unmount === 'function' ? pluginInstance.unmount() : null)
        .then(() => {
          delete this.pluginInstances[plugin];
          delete this.pluginApis[plugin];

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
      ['unload', 'load'].forEach(type => {
        this.onMessageType(type, (err, result) => {
          if (!err) {
            this.emit(type, result);
          } else {
            console.warn(err);
          }
        });
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

  onMessageType(type, handler) {
    const listener = m => {
      if (m.type === type) {
        handler(m.error, m.result);
      } else if (m.globalError) {
        handler(m.globalError);
      }
    };
    this._messageListeners.push(listener);
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
  const l = window.location || {
    protocol: 'http:',
    host: '127.0.0.1',
    port: String(8080),
    pathname: '/',
  };
  return ((l.protocol === 'https:') ? 'wss://' : 'ws://') + l.host + l.pathname + (!/\/$/.test(l.pathname) ? '/' : '') + s;
};

const _instantiate = (o, arg) => {
  if (typeof o === 'function') {
    if (o.prototype && o.prototype.constructor.name) {
      return new o(arg);
    } else {
      return o(arg);
    }
  } else {
    return o;
  }
};

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
if (typeof window.module === 'undefined') {
  window.module = {};
  window.archae = archae;
}
module.exports = archae;

})(typeof window !== 'undefined' ? window : global);
