const events = require('events');
const {EventEmitter} = events;
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const child_process = require('child_process');

const spdy = require('spdy');
const express = require('express');
const ws = require('ws');
const etag = require('etag');
const mkdirp = require('mkdirp');
const rimraf = require('rimraf');
const rollup = require('rollup');
const rollupPluginNodeResolve = require('rollup-plugin-node-resolve');
const rollupPluginCommonJs = require('rollup-plugin-commonjs');
const rollupPluginJson = require('rollup-plugin-json');
const watchr = require('watchr');
const cryptoutils = require('cryptoutils');
const MultiMutex = require('multimutex');

const defaultConfig = {
  hostname: 'archae',
  altHostnames: [],
  host: null,
  port: 8000,
  secure: false,
  publicDirectory: null,
  dataDirectory: 'data',
  cryptoDirectory: 'crypto',
  installDirectory: 'installed',
  metadata: null,
};

const npmCommands = {
  install: [
    path.join(path.dirname(require.resolve('rollup')), '..', '..', 'yarn-zeo', 'bin', 'yarn'),
    'add',
    '--production',
  ],
};
const pathSymbol = Symbol();
const nameSymbol = Symbol();

class ArchaeServer extends EventEmitter {
  constructor({
    dirname,
    hostname,
    host,
    port,
    secure,
    publicDirectory,
    dataDirectory,
    cryptoDirectory,
    installDirectory,
    metadata,
    server,
    app,
    wss,
    generateCerts,
    locked,
    whitelist,
    cors,
    corsOrigin,
    staticSite,
  } = {}) {
    super();

    dirname = dirname || process.cwd();
    this.dirname = dirname;

    hostname = hostname || defaultConfig.hostname;
    this.hostname = hostname;

    port = port || defaultConfig.port;
    this.port = port;

    secure = (typeof secure === 'boolean') ? secure : defaultConfig.secure;
    this.secure = secure;

    publicDirectory = publicDirectory || defaultConfig.publicDirectory;
    this.publicDirectory = publicDirectory;

    dataDirectory = dataDirectory || defaultConfig.dataDirectory;
    this.dataDirectory = dataDirectory;

    cryptoDirectory = cryptoDirectory || defaultConfig.cryptoDirectory;
    this.cryptoDirectory = cryptoDirectory;

    installDirectory = installDirectory || defaultConfig.installDirectory;
    this.installDirectory = installDirectory;

    metadata = metadata || defaultConfig.metadata;
    this.metadata = metadata;

    server = server || null;
    this.server = server;

    app = app || express();
    this.app = app;

    wss = wss || null;
    this.wss = wss;

    generateCerts = generateCerts || false;
    this.generateCerts = generateCerts;

    locked = locked || false;
    this.locked = locked;

    this.whitelistIndex = null;
    whitelist = whitelist || null;
    this.setWhitelist(whitelist);

    cors = cors || false;
    this.cors = cors;

    corsOrigin = corsOrigin || '*';
    this.corsOrigin = corsOrigin;

    staticSite = staticSite || false;
    this.staticSite = staticSite;

    this.publicBundlePromise = null;

    const pather = new ArchaePather(dirname, installDirectory);
    this.pather = pather;
    const installer = new ArchaeInstaller(dirname, installDirectory, pather);
    this.installer = installer;

    this.connections = [];

    this.plugins = {};
    this.pluginInstances = {};
    this.pluginApis = {};
    this.watchers = {};
    this.installsMutex = new MultiMutex();
    this.loadsMutex = new MultiMutex();
    this.mountsMutex = new MultiMutex();
  }

  loadCerts() {
    const {dirname, hostname, cryptoDirectory, generateCerts} = this;

    const _getOldCerts = () => {
      const _getCertFile = fileName => {
        try {
          return fs.readFileSync(path.join(cryptoDirectory, 'cert', fileName), 'utf8');
        } catch(err) {
          if (err.code !== 'ENOENT') {
            console.warn(err);
          }
          return null;
        }
      };

      const privateKey = _getCertFile('private.pem');
      const cert = _getCertFile('cert.pem');
      if (privateKey && cert) {
        return {
          privateKey,
          cert,
        };
      } else {
        return null;
      }
    };

    const _getNewCerts = () => {
      if (generateCerts) {
        const keys = cryptoutils.generateKeys();
        const cert = cryptoutils.generateCert(keys, {
          commonName: hostname,
        });

        const certDirectory = path.join(cryptoDirectory, 'cert');
        const _makeCertDirectory = () => {
          mkdirp.sync(certDirectory);
        };
        const _setCertFile = (fileName, fileData) => {
          fs.writeFileSync(path.join(certDirectory, fileName), fileData);
        };

        _makeCertDirectory();
        _setCertFile('public.pem', keys.publicKey);
        _setCertFile('private.pem', keys.privateKey);
        _setCertFile('cert.pem', cert);

        return {
          privateKey,
          cert,
        };
      } else {
        return null;
      }
    };

    return _getOldCerts() || _getNewCerts();
  }

  getServer() {
    const {secure} = this;

    if (!secure) {
      return http.createServer();
    } else {
      const certs = this.loadCerts();

      if (certs) {
        return spdy.createServer({
          cert: certs.cert,
          key: certs.privateKey,
        });
      } else {
        return null;
      }
    }
  }

  getWss() {
    return new ws.Server({
      noServer: true,
    });
  }

  requestPlugin(plugin, {force = false, hotload = false} = {}) {
    return this.requestPlugins([plugin], {force, hotload})
      .then(([plugin]) => Promise.resolve(plugin));
  }

  getModuleRealNames(plugins) {
    return Promise.all(plugins.map(plugin => new Promise((accept, reject) => {
      const {pather} = this;

      pather.getModuleRealName(plugin, (err, pluginName) => {
        if (!err) {
          accept(pluginName);
        } else {
          reject(err);
        }
      });
    })));
  }

  installPlugins(plugins, {force = false} = {}) {
    return new Promise((accept, reject) => {
      const {installer} = this;

      const cb = (err, result) => {
        if (!err) {
          accept(result);
        } else {
          reject(err);
        }
      };

      const _lockPlugins = (mutex, pluginNames) => Promise.all(pluginNames.map(pluginName => mutex.lock(pluginName)))
        .then(unlocks => Promise.resolve(() => {
          for (let i = 0; i < unlocks.length; i++) {
            const unlock = unlocks[i];
            unlock();
          }
        }));

      this.getModuleRealNames(plugins)
        .then(pluginNames => {
          _lockPlugins(this.installsMutex, pluginNames)
            .then(unlock => {
              installer.addModules(plugins, pluginNames, force, err => {
                if (!err) {
                  cb(null, pluginNames);
                } else {
                  cb(err);
                }

                unlock();
              });
            })
            .catch(err => {
              cb(err);
            });
        })
        .catch(err => {
          cb(err);
        });
    });
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

      const _installPlugins = plugins => {
        const {locked} = this;

        if (!locked) {
          return this.installPlugins(plugins, {force});
        } else {
          return this.getModuleRealNames(plugins);
        }
      };
      const _bootPlugins = pluginNames => Promise.all(pluginNames.map((pluginName, index) => new Promise((accept, reject) => {
        const plugin = plugins[index];

        const cb = (err, result) => {
          if (!err) {
            accept(result);
          } else {
            reject(err);
          }
        };

        this.loadsMutex.lock(pluginName)
          .then(unlock => {
            this.watchPlugin(plugin, pluginName, {hotload});

            this.loadPlugin(pluginName, err => {
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

              unlock();
            });
          })
          .catch(err => {
            cb(err);
          });
      })));

      if (this.checkWhitelist(plugins)) {
        _installPlugins(plugins)
          .then(pluginNames => {
            _bootPlugins(pluginNames)
              .then(pluginApis => {
                cb(null, pluginApis);
              })
              .catch(err => {
                cb(err);
              });
          })
          .catch(err => {
            cb(err);
          });
      } else {
        const err = new Error('plugin whitelist violation: ' + JSON.stringify(plugins));
        cb(err);
      }
    });
  }

  releasePlugin(plugin) {
    return new Promise((accept, reject) => {
      const {pather} = this;

      if (this.checkWhitelist([plugin])) {
        pather.getModuleRealName(plugin, (err, pluginName) => {
          if (!err) {
            this.mountsMutex.lock(pluginName)
              .then(unlock => new Promise((accept, reject) => {
                this.unmountPlugin(plugin, pluginName, err => {
                  if (!err) {
                    this.unloadPlugin(pluginName);

                    this.unwatchPlugin(plugin);

                    accept(pluginName);
                  } else {
                    reject(err);
                  }

                  unlock();
                });
              }))
              .then(accept)
              .catch(reject);
          } else {
            reject(err);
          }
        });
      } else {
        reject(new Error('plugin whitelist violation: ' + JSON.stringify(plugin)));
      }
    });
  }

  releasePlugins(plugins) {
    const releasePluginPromises = plugins.map(plugin => this.releasePlugin(plugin));
    return Promise.all(releasePluginPromises);
  }

  removePlugin(plugin) {
    return new Promise((accept, reject) => {
      const {installer} = this;

      if (this.checkWhitelist([plugin])) {
        this.releasePlugin(plugin)
          .then(pluginName =>
            this.installsMutex.lock(pluginName)
              .then(unlock => new Promise((accept, reject) => {
                installer.removeModule(pluginName, err => {
                  if (!err) {
                    accept({
                      plugin,
                      pluginName,
                    });
                  } else {
                    reject(err);
                  }

                  unlock();
                });
              }))
          )
          .then(accept)
          .catch(reject);
      } else {
        reject(new Error('plugin whitelist violation: ' + JSON.stringify(plugin)));
      }
    });
  }

  removePlugins(plugins) {
    const removePluginPromises = plugins.map(plugin => this.removePlugin(plugin));
    return Promise.all(removePluginPromises);
  }

  getLoadedPlugins() {
    return Object.keys(this.plugins).sort();
  }

  loadPlugin(pluginName, cb) {
    const {pather} = this;

    const existingPlugin = this.plugins[pluginName];

    if (existingPlugin !== undefined) {
      cb();
    } else {
      pather.getPackageJsonFileName(pluginName, 'server', (err, fileName) => {
        if (!err) {
          if (fileName) {
            const {dirname, installDirectory} = this;
            const modulePath = path.join( installDirectory, 'plugins', pluginName, 'node_modules', pluginName, fileName);
            const moduleInstance = require(modulePath);

            this.plugins[pluginName] = moduleInstance;
          } else {
            this.plugins[pluginName] = null;
          }

          cb();
        } else {
          cb(err);
        }
      });
    }
  }

  unloadPlugin(pluginName) {
    delete this.plugins[pluginName];
  }

  watchPlugin(plugin, pluginName, {hotload}) {
    if (this.watchers[plugin] === undefined) {
      const watcher = (() => {
        if (hotload && /^\//.test(plugin)) {
          const {dirname} = this;
          const moduleDirectoryPath = path.join(dirname, plugin);
          const watcher = new watchr.Watcher(moduleDirectoryPath);
          watcher.setConfig({
            catchupDelay: 100,
          });
          const change = (/*changeType, fullPath, currentStat, previousStat*/) => {
            this.broadcast('unload', pluginName);

            this.removePlugin(plugin)
              .then(() => {
                this.broadcast('load', plugin);

                return this.requestPlugin(plugin, {
                  hotload: true,
                });
              })
              .catch(err => {
                console.warn(err);
              });
          };
          watcher.on('change', change);
          watcher.once('close', () => {
            watcher.removeListener('change', change);
          });
          watcher.watch(err => {
            if (err) {
              console.warn(err);
            }
          });

          return watcher;
        } else {
          return null;
        }
      })();
      this.watchers[plugin] = watcher;
    }
  }

  unwatchPlugin(plugin) {
    const watcher = this.watchers[plugin];
    if (watcher) {
      watcher.close();
    }
    delete this.watchers[plugin];
  }

  broadcast(type, result) {
    const e = {
      type,
      result,
    };
    const es = JSON.stringify(e);

    const {connections} = this;
    for (let i = 0; i < connections.length; i++) {
      const connection = connections[i];
      connection.send(es);
    }
  }

  mountPlugin(plugin, pluginName, cb) {
    const existingPluginApi = this.pluginApis[pluginName];

    if (existingPluginApi !== undefined) {
      cb();
    } else {
      const moduleRequire = this.plugins[pluginName];

      if (moduleRequire !== null) {
        Promise.resolve(_instantiate(moduleRequire, this))
          .then(pluginInstance => {
            this.pluginInstances[plugin] = pluginInstance;

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
        this.pluginInstances[pluginName] = {};
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
      Promise.resolve(typeof pluginInstance.unmount === 'function' ? pluginInstance.unmount : null)
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

  lock() {
    this.locked = true;
  }

  unlock() {
    this.locked = false;
  }

  checkWhitelist(plugins) {
    const {whitelistIndex} = this;

    return !whitelistIndex || plugins.every(plugin => whitelistIndex[plugin]);
  }

  setWhitelist(whitelist) {
    if (whitelist) {
      this.whitelistIndex = _makeIndex(whitelist);
    } else  {
      this.whitelistIndex = null;
    }
  }

  getCore() {
    return {
      express: express,
      ws: ws,
      server: this.server,
      app: this.app,
      wss: this.wss,
      dirname: this.dirname,
      dataDirectory: this.dataDirectory,
    };
  }

  getPath(pluginApi) {
    return pluginApi ? pluginApi[pathSymbol] : null;
  }

  getName(pluginApi) {
    return pluginApi ? pluginApi[nameSymbol] : null;
  }

  mountApp() {
    const {hostname, dirname, publicDirectory, installDirectory, metadata, server, app, wss, cors, corsOrigin, staticSite, pather} = this;

    // cross-origin resoure sharing
    if (cors) {
      app.all('*', (req, res, next) => {
        res.set('Access-Control-Allow-Origin', corsOrigin);
        res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        res.set('Access-Control-Allow-Credentials', 'true');

        next();
      });
    }

    // user public
    if (publicDirectory) {
      app.use('/', express.static(publicDirectory));
    }

    class UpgradeEvent {
      constructor(req, socket, head) {
        this.req = req;
        this.socket = socket;
        this.head = head;

        this._live = true;
      }

      isLive() {
        return this._live;
      }

      stopImmediatePropagation() {
        this._live = false;
      }
    }

    server.on('upgrade', (req, socket, head) => {
      if (!staticSite) {
        const upgradeEvent = new UpgradeEvent(req, socket, head);
        wss.emit('upgrade', upgradeEvent);

        if (upgradeEvent.isLive()) {
          wss.handleUpgrade(req, socket, head, c => {
            wss.emit('connection', c);
          });
        }
      } else {
        socket.destroy();
      }
    });

    if (!staticSite) {
      // archae public
      app.get('/archae/archae.js', (req, res, next) => {
        this.publicBundlePromise
          .then(codeObject => {
            res.type('application/javascript');
            res.setHeader('ETag', codeObject.etag)
            res.send(String(codeObject));
          })
          .catch(err => {
            res.status(500);
            res.send(err.stack);
          });
      });

      // archae lists
      app.use('/archae/plugins.json', (req, res, next) => {
        const plugins = this.getLoadedPlugins();

        res.type('application/json');
        res.send(JSON.stringify({
          plugins,
        }, null, 2));
      });

      // archae bundles
      const _serveJsFile = (req, res, {module, build = null}) => {
          const srcPath = path.join(installDirectory, 'plugins', module, 'node_modules', module, '.archae', (build ? ('build/' + build) : 'client') + '.js');

        fs.readFile(srcPath, (err, d) => {
          if (!err) {
            res.type('application/javascript');

            const et = etag(d);

            if (req.get('If-None-Match') === et) {
              res.status(304);
              res.send();
            } else {
              res.set('Etag', et);
              res.send(d);
            }
          } else if (err.code === 'ENOENT') {
            res.status(404);
            res.send();
          } else {
            res.status(500);
            res.send(err.stack);
          }
        });
      };

      app.get(/^\/archae\/plugins\/([^\/]+?)\/([^\/]+)\.js$/, (req, res, next) => {
        const {params} = req;
        const module = params[0];
        const target = params[1];

        if (module === target) {
          _serveJsFile(req, res, {
            module,
          });
        } else {
          next();
        }
      });
      app.get(/^\/archae\/plugins\/([^\/]+?)\/build\/(.+)\.js$/, (req, res, next) => {
        const {params} = req;
        const module = params[0];
        const build = params[1];

        if (!/\.\./.test(build)) {
          _serveJsFile(req, res, {
            module,
            build,
          });
        } else {
          res.status(400);
          res.send();
        }
      });

      wss.on('connection', c => {
        c.send = (send =>
          (data, cb = err => {
            if (err) {
              console.warn(err);
            }
          }) =>
            send.call(c, data, cb)
        )(c.send);
        c.on('error', err => {
          console.warn(err);

          c.close();
        });

        const {url} = c.upgradeReq;
        if (url === '/archae/ws') {
          console.log('connection open');

          this.connections.push(c);

          const e = {
            type: 'init',
            error: null,
            result: {
              metadata,
            },
          };
          const es = JSON.stringify(e);
          c.send(es);

          c.on('message', s => {
            const m = JSON.parse(s);

            const cb = err => {
              console.warn(err);
            };

            const _respondInvalidMessage = () => {
              const err = new Error('invalid message');
              cb(err);
            };

            if (typeof m === 'object' && m && typeof m.method === 'string' && ('args' in m) && typeof m.id === 'string') {
              const cb = (err = null, result = null) => {
                if (c.readyState === ws.OPEN) {
                  const e = {
                    id: m.id,
                    error: err ? (err.stack || err) : null,
                    result: result,
                  };
                  const es = JSON.stringify(e);
                  c.send(es);
                }
              };

              const _respondInvalidMethod = () => {
                const err = new Error('invalid message method: ' + JSON.stringify(method));
                cb(err);
              };

              const {method, args} = m;
              if (method === 'requestPlugin') {
                const {plugin, force, hotload} = args;

                this.requestPlugin(plugin, {force, hotload})
                  .then(pluginApi => {
                    const pluginName = this.getName(pluginApi);

                    pather.getPluginClient(pluginName, (err, clientFileName) => {
                      if (!err) {
                        const hasClient = Boolean(clientFileName);

                        cb(null, {
                          plugin,
                          pluginName,
                          hasClient,
                        });
                      } else {
                        cb(err);
                      }
                    });
                  })
                  .catch(err => {
                    cb(err);
                  });
              } else if (method === 'requestPlugins') {
                const {plugins, force, hotload} = args;

                this.requestPlugins(plugins, {force, hotload})
                  .then(pluginApis => Promise.all(pluginApis.map((pluginApi, index) => new Promise((accept, reject) => {
                    const plugin = plugins[index];
                    const pluginName = this.getName(pluginApi);

                    pather.getPluginClient(pluginName, (err, clientFileName) => {
                      if (!err) {
                        const hasClient = Boolean(clientFileName);

                        accept({
                          plugin,
                          pluginName,
                          hasClient,
                        });
                      } else {
                        reject(err);
                      }
                    });
                  }))))
                  .then(pluginSpecs => {
                    cb(null, pluginSpecs);
                  })
                  .catch(err => {
                    cb(err);
                  });
              } else {
                const {locked} = this;

                if (!locked) {
                  if (method === 'removePlugin') {
                    const {plugin} = args;

                    this.removePlugin(plugin)
                      .then(result => {
                        cb(null, result);
                      })
                      .catch(err => {
                        cb(err);
                      });
                  } else if (method === 'removePlugins') {
                    const {plugins} = args;

                    this.removePlugins(plugins)
                      .then(result => {
                        cb(null, result);
                      })
                      .catch(err => {
                        cb(err);
                      });
                  } else {
                    _respondInvalidMethod();
                  }
                } else {
                  _respondInvalidMethod();
                }
              }
            } else {
              _respondInvalidMessage();
            }
          });
          c.on('close', () => {
            console.log('connection close');

            this.connections.splice(this.connections.indexOf(c), 1);
          });
        }
      });
    }

    // mount on server
    server.on('request', app);
  }

  listen(cb) {
    const _ensurePublicBundlePromise = () => {
      this.publicBundlePromise = _requestRollup(path.join(__dirname, 'lib', 'archae.js'))
        .then(codeString => {
          const codeObject = new String(codeString);
          codeObject.etag = etag(codeString);
          return Promise.resolve(codeObject);
        })
        .catch(err => {
          console.warn(err);
        });

      return Promise.resolve();
    };
    const _ensureServers = () => Promise.all([
      new Promise((accept, reject) => {
        if (!this.server) {
          const server = this.getServer();

          if (server) {
            this.server = server;

            accept();
          } else {
            const err = new Error('could not generate server due to missing crypto certificates and no generateCerts flag');
            reject(err);
          }
        } else {
          accept();
        }
      }),
      new Promise((accept, reject) => {
        if (!this.wss) {
          this.wss = this.getWss();
        }

        accept();
      }),
    ]);
    const _mountApp = () => {
      this.mountApp();

      return Promise.resolve();
    };
    const _listen = () => new Promise((accept, reject) => {
      const {host, port, server} = this;

      const listening = () => {
        accept();

        _cleanup();
      };
      const error = err => {
        reject(err);

        _cleanup();
      };

      const _cleanup = () => {
        server.removeListener('listening', listening);
        server.removeListener('error', error);
      };

      server.listen(port, host);
      server.on('listening', listening);
      server.on('error', error);
    });

    _ensurePublicBundlePromise()
      .then(() => _ensureServers())
      .then(() => _mountApp())
      .then(() => _listen())
      .then(() => {
        this.emit('listen');

        cb();
      })
      .catch(err => {
        cb(err);
      });
  }
}

class ArchaePather {
  constructor(dirname, installDirectory) {
    this.dirname = dirname;
    this.installDirectory = installDirectory;
  }

  getModuleRealName(module, cb) {
    if (path.isAbsolute(module)) {
      fs.readFile(this.getLocalModulePackageJsonPath(module), 'utf8', (err, s) => {
        if (!err) {
          const j = JSON.parse(s);
          const moduleName = j.name;
          const displayName = module.match(/([^\/]*)$/)[1];

          if (moduleName === displayName) {
            cb(null, moduleName);
          } else {
            const err = new Error('module name in package.json does not match path: ' + JSON.stringify(module));
            cb(err);
          }
        } else {
          cb(err);
        }
      });
    } else {
      process.nextTick(() => {
        const moduleName = module;
        cb(null, moduleName);
      });
    }
  }

  getInstalledModulePath(moduleName) {
    const {dirname, installDirectory} = this;
    return path.join( installDirectory, 'plugins', moduleName, 'node_modules', moduleName);
  }

  getLocalModulePath(module) {
    const {dirname} = this;
    return path.join(dirname, module);
  }

  getInstalledModulePackageJsonPath(moduleName) {
    return path.join(this.getInstalledModulePath(moduleName), 'package.json');
  }

  getLocalModulePackageJsonPath(module) {
    return path.join(this.getLocalModulePath(module), 'package.json');
  }

  getPackageJsonFileName(plugin, packageJsonFileNameKey, cb) {
    const {dirname, installDirectory} = this;

    fs.readFile(this.getInstalledModulePackageJsonPath(plugin), 'utf8', (err, s) => {
      if (!err) {
        const j = JSON.parse(s);
        const fileName = j[packageJsonFileNameKey];
        cb(null, fileName);
      } else {
        cb(err);
      }
    });
  }

  getPluginClient(plugin, cb) {
    this.getPackageJsonFileName(plugin, 'client', cb);
  }

  getPluginBuilds(plugin, cb) {
    this.getPackageJsonFileName(plugin, 'builds', cb);
  }
}

class ArchaeInstaller {
  constructor(dirname, installDirectory, pather) {
    this.dirname = dirname;
    this.installDirectory = installDirectory;
    this.pather = pather;

    this.running = false;
    this.queue = [];
  }

  addModules(modules, moduleNames, force, cb) {
    const {dirname, installDirectory, pather} = this;

    const _getInstalledFlagFilePath = moduleName => path.join(installDirectory, 'plugins', moduleName, 'node_modules', moduleName, '.archae', 'installed.txt');
    const _writeFile = (p, d) => new Promise((accept, reject) => {
      mkdirp(path.dirname(p), err => {
        if (!err) {
          fs.writeFile(p, d, err => {
            if (!err) {
              accept();
            } else {
              reject(err);
            }
          });
        } else {
          reject(err);
        }
      });
    });
    const _requestInstallableModules = (modules, moduleNames, force, cb) => {
      if (force) {
        cb(null, modules, moduleNames);
      } else {
        Promise.all(moduleNames.map(moduleName => new Promise((accept, reject) => {
          fs.lstat(_getInstalledFlagFilePath(moduleName), err => {
            if (!err) {
              accept(true);
            } else if (err.code === 'ENOENT') {
              accept(false);
            } else {
              reject(err);
            }
          });
        })))
          .then(modulesExists => {
            const existingModules = modules.filter((module, index) => !modulesExists[index]);
            const existingModuleNames = moduleNames.filter((moduleName, index) => !modulesExists[index]);

            cb(null, existingModules, existingModuleNames);
          })
          .catch(err => {
            cb(err);
          });
      }
    };
    const _npmInstall = (modules, moduleNames, cb) => {
      Promise.all(modules.map((module, index) => {
        const moduleName = moduleNames[index];

        const _ensureNodeModules = (module, moduleName) => new Promise((accept, reject) => {
            mkdirp(path.join( installDirectory, 'plugins', moduleName, 'node_modules'), err => {
            if (!err) {
              accept();
            } else {
              reject(err);
            }
          });
        });
        const _install = (module, moduleName) => new Promise((accept, reject) => {
          const modulePath = (() => {
            if (path.isAbsolute(module)) {
              return 'file:' + path.join(dirname, module);
            } else {
              return module;
            }
          })();
          const npmInstall = child_process.spawn(
            npmCommands.install[0],
            npmCommands.install.slice(1).concat([
                '--cache-folder', path.join(installDirectory, 'caches', moduleName),
              modulePath,
            ]),
            {
                cwd: path.join( installDirectory, 'plugins', moduleName),
            }
          );
          npmInstall.stdout.pipe(process.stdout);
          npmInstall.stderr.pipe(process.stderr);
          npmInstall.on('exit', code => {
            if (code === 0) {
              accept();
            } else {
              reject(new Error('npm install error: ' + code));
            }
          });
          npmInstall.on('error', err => {
            reject(err);
          });
        });
        const _build = (module, moduleName) => {
          const _buildClient = () => new Promise((accept, reject) => {
            pather.getPluginClient(moduleName, (err, clientFileName) => {
              if (!err) {
                if (typeof clientFileName === 'string') {
                    const srcPath = path.join(installDirectory, 'plugins', moduleName, 'node_modules', moduleName, clientFileName);
                    const dstPath = path.join(installDirectory, 'plugins', moduleName, 'node_modules', moduleName, '.archae', 'client.js');

                  return _requestRollup(srcPath)
                    .then(code => _writeFile(dstPath, code))
                    .then(accept)
                    .catch(reject);
                } else {
                  accept();
                }
              } else {
                reject(err);
              }
            });
          });
          const _buildBuilds = () => new Promise((accept, reject) => {
            pather.getPluginBuilds(moduleName, (err, buildFileNames) => {
              if (!err) {
                if (Array.isArray(buildFileNames)) {
                  Promise.all(buildFileNames.map(buildFileName => {
                    const srcPath = path.join(installDirectory, 'plugins', moduleName, 'node_modules', moduleName, buildFileName);
                    const dstPath = path.join( installDirectory, 'plugins', moduleName, 'node_modules', moduleName, '.archae', 'build', buildFileName);

                    return _requestRollup(srcPath)
                      .then(code => _writeFile(dstPath, code))
                      .then(accept)
                      .catch(reject);
                  }))
                    .then(accept)
                    .catch(reject);
                } else {
                  accept();
                }
              } else {
                reject(err);
              }
            });
          });

          return Promise.all([
            _buildClient(),
            _buildBuilds(),
          ]);
        };

        return _ensureNodeModules(module, moduleName)
          .then(() => _install(module, moduleName))
          .then(() => _build(module, moduleName));
      }))
        .then(() => {
          cb();
        })
        .catch(err => {
          cb(err);
        });
    };
    const _markInstalledModules = (moduleNames, cb) => {
      Promise.all(moduleNames.map(moduleName => _writeFile(_getInstalledFlagFilePath(moduleName))))
        .then(() => {
          cb();
        })
        .catch(err => {
          cb(err);
        });
    };

    _requestInstallableModules(modules, moduleNames, force, (err, modules, moduleNames) => {
      if (!err) {
        if (modules.length > 0) {
          _npmInstall(modules, moduleNames, err => {
            if (!err) {
              _markInstalledModules(moduleNames, err => {
                if (!err) {
                  cb();
                } else {
                  cb(err);
                }
              });
            } else {
              cb(err);
            }
          });
        } else {
          cb();
        }
      } else {
        cb(err);
      }
    });
  }

  removeModule(moduleName, cb) {
    const {pather} = this;

    const modulePath = pather.getInstalledModulePath(moduleName);
    rimraf(modulePath, cb);
  }

  queueNpm(handler) {
    const {running, queue} = this;

    if (!running) {
      this.running = true;

      handler(() => {
        this.running = false;

        if (queue.length > 0) {
          this.queueNpm(queue.pop());
        }
      });
    } else {
      queue.push(handler);
    }
  }
}

const _makeIndex = a => {
  const result = {};
  for (let i = 0; i < a.length; i++) {
    const e = a[i];
    result[e] = true;
  }
  return result;
};
const _instantiate = (o, arg) => {
  if (typeof o === 'function') {
    if (/^(?:function|class)/.test(o.toString())) {
      return new o(arg);
    } else {
      return o(arg);
    }
  } else {
    return o;
  }
};
// const _uninstantiate = api => (typeof api.unmount === 'function') ? api.unmount() : null;
const _requestRollup = p => rollup.rollup({
  entry: p,
  plugins: [
    rollupPluginNodeResolve({
      main: true,
      preferBuiltins: false,
    }),
    rollupPluginCommonJs(),
    rollupPluginJson(),
  ],
})
  .then(bundle => {
    const result = bundle.generate({
      moduleName: module,
      format: 'cjs',
      useStrict: false,
    });
    const {code} = result;
    const wrappedCode = '(function() {\n' + code + '\n})();\n';
    return wrappedCode;
  });

const archae = opts => new ArchaeServer(opts);
module.exports = archae;
