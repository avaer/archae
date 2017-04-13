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
const mkdirp = require('mkdirp');
const rimraf = require('rimraf');
const rollup = require('rollup');
const rollupPluginNodeResolve = require('rollup-plugin-node-resolve');
const rollupPluginCommonJs = require('rollup-plugin-commonjs');
const rollupPluginJson = require('rollup-plugin-json');
const cryptoutils = require('cryptoutils');
const MultiMutex = require('multimutex');
const fsHasher = require('fs-hasher');

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
  install: ['npm', 'install', '--production', '--unsafe-perm'],
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

    const pather = new ArchaePather(dirname, installDirectory);
    this.pather = pather;
    const hasher = new ArchaeHasher(dirname, installDirectory, pather);
    this.hasher = hasher;
    const installer = new ArchaeInstaller(dirname, installDirectory, pather, hasher);
    this.installer = installer;

    this.connections = [];

    this.plugins = {};
    this.pluginInstances = {};
    this.pluginApis = {};
    this.installsMutex = new MultiMutex();
    this.loadsMutex = new MultiMutex();
    this.mountsMutex = new MultiMutex();
  }

  loadCerts() {
    const {dirname, hostname, cryptoDirectory, generateCerts} = this;

    const _getOldCerts = () => {
      const _getCertFile = fileName => {
        try {
          return fs.readFileSync(path.join(dirname, cryptoDirectory, 'cert', fileName), 'utf8');
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

        const certDirectory = path.join(dirname, cryptoDirectory, 'cert');
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

  requestPlugin(plugin) {
    return this.requestPlugins([plugin])
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

  installPlugins(plugins) {
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
              installer.addModules(plugins, err => {
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

  requestPlugins(plugins) {
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
          return this.installPlugins(plugins);
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
            reject(err);
          });
      } else {
        const err = new Error('plugin whitelist violation: ' + JSON.stringify(plugins));
        reject(err);
      }
    });
  }

  releasePlugin(plugin) {
    return new Promise((accept, reject) => {
      const {pather, installer} = this;

      const cb = (err, result) => {
        if (!err) {
          accept(result);
        } else {
          reject(err);
        }
      };

      if (this.checkWhitelist([plugin])) {
        pather.getModuleRealName(plugin, (err, pluginName) => {
          this.mountsMutex.lock(pluginName)
            .then(unlock => {
              this.unmountPlugin(plugin, pluginName, err => {
                if (!err) {
                  this.unloadPlugin(pluginName);

                  this.installsMutex.lock(pluginName)
                    .then(unlock => {
                      installer.removeModule(pluginName, err => {
                        if (!err) {
                          cb(null, {
                            plugin,
                            pluginName,
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
                } else {
                  cb(err);
                }

                unlock();
              });
            })
            .catch(err => {
              cb(err);
            });
        });
      } else {
        const err = new Error('plugin whitelist violation: ' + JSON.stringify(plugin));
        reject(err);
      }
    });
  }

  releasePlugins(plugins) {
    const releasePluginPromises = plugins.map(plugin => this.releasePlugin(plugin));
    return Promise.all(releasePluginPromises);
  }

  getPackageJsonFileName(plugin, packageJsonFileNameKey, cb) {
    const {dirname, installDirectory} = this;

    fs.readFile(path.join(dirname, installDirectory, 'plugins', 'node_modules', plugin, 'package.json'), 'utf8', (err, s) => {
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

  getLoadedPlugins() {
    return Object.keys(this.plugins).sort();
  }

  loadPlugin(plugin, cb) {
    const existingPlugin = this.plugins[plugin];

    if (existingPlugin !== undefined) {
      cb();
    } else {
      this.getPackageJsonFileName(plugin, 'server', (err, fileName) => {
        if (!err) {
          if (fileName) {
            const {dirname, installDirectory} = this;
            const moduleRequire = require(path.join(dirname, installDirectory, 'plugins', 'node_modules', plugin, fileName));

            this.plugins[plugin] = moduleRequire;
          } else {
            this.plugins[plugin] = null;
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
    const {hostname, dirname, publicDirectory, installDirectory, metadata, server, app, wss, cors, corsOrigin, staticSite} = this;

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
      app.use('/', express.static(path.join(dirname, publicDirectory)));
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
      app.use('/', express.static(path.join(__dirname, 'public')));

      // archae lists
      app.use('/archae/plugins.json', (req, res, next) => {
        const plugins = this.getLoadedPlugins();

        res.type('application/json');
        res.send(JSON.stringify({
          plugins,
        }, null, 2));
      });

      // archae bundles
      const bundleCache = {};
      const _requestBundle = ({module, build = null}) => rollup.rollup({
        entry: path.join(dirname, installDirectory, 'plugins', 'node_modules', module, (build ? build : 'client') + '.js'),
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
      app.get(/^\/archae\/plugins\/([^\/]+?)\/([^\/]+)\.js$/, (req, res, next) => {
        const {params} = req;
        const module = params[0];
        const target = params[1];

        if (module === target) {
          const _respondOk = s => {
            res.type('application/javascript');
            res.send(s);
          };

          const key = module + ':client';
          const entry = bundleCache[key];
          if (entry !== undefined) {
            _respondOk(entry);
          } else {
            _requestBundle({
              module,
            })
              .then(code => {
                bundleCache[key] = code;

                _respondOk(code);
              })
              .catch(err => {
                res.status(500);
                res.send(err.stack);
              });
          }
        } else {
          next();
        }
      });
      app.get(/^\/archae\/plugins\/([^\/]+?)\/build\/(.+)\.js$/, (req, res, next) => {
        const {params} = req;
        const module = params[0];
        const build = params[1];

        if (!/\.\./.test(build)) {
          const _respondOk = s => {
            res.type('application/javascript');
            res.send(s);
          };

          const key = module + ':build:' + build;
          const entry = bundleCache[key];
          if (entry !== undefined) {
            _respondOk(entry);
          } else {
            _requestBundle({
              module,
              build,
            })
              .then(code => {
                bundleCache[key] = code;

                _respondOk(code);
              })
              .catch(err => {
                res.status(500);
                res.send(err.stack);
              });
          }
        } else {
          res.status(400);
          res.send();
        }
      });

      wss.on('connection', c => {
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
                const {plugin} = args;

                this.requestPlugin(plugin)
                  .then(pluginApi => {
                    const pluginName = this.getName(pluginApi);

                    this.getPluginClient(pluginName, (err, clientFileName) => {
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
                const {plugins} = args;

                this.requestPlugins(plugins)
                  .then(pluginApis => Promise.all(pluginApis.map((pluginApi, index) => new Promise((accept, reject) => {
                    const plugin = plugins[index];
                    const pluginName = this.getName(pluginApi);

                    this.getPluginClient(pluginName, (err, clientFileName) => {
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
                  if (method === 'releasePlugin') {
                    const {plugin} = args;

                    this.releasePlugin(plugin)
                      .then(result => {
                        cb(null, result);
                      })
                      .catch(err => {
                        cb(err);
                      });
                  } else if (method === 'releasePlugins') {
                    const {plugins} = args;

                    this.releasePlugins(plugins)
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

    _ensureServers()
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
      const packageJsonPath = this.getLocalModulePackageJsonPath(module);

      fs.readFile(packageJsonPath, 'utf8', (err, s) => {
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
    return path.join(dirname, installDirectory, 'plugins', 'node_modules', moduleName);
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
}

const MODULE_HASHES_MUTEX_KEY = 'key';
class ArchaeHasher {
  constructor(dirname, installDirectory, pather) {
    this.dirname = dirname;
    this.installDirectory = installDirectory;
    this.pather = pather;

    this.moduleHashesMutex = new MultiMutex();
    this.modulesHashesJson = null;
    this.validatedModuleHashes = {};
  }

  loadModulesHashesJson(cb) {
    const {dirname, installDirectory, moduleHashesMutex, modulesHashesJson} = this;

    if (modulesHashesJson !== null) {
      process.nextTick(() => {
        cb(null, modulesHashesJson);
      });
    } else {
      moduleHashesMutex.lock(MODULE_HASHES_MUTEX_KEY)
        .then(unlock => {
          const unlockCb = (err, result) => {
            cb(err, result);

            unlock();
          };

          const cachePath = path.join(dirname, installDirectory, 'cache');
          const cacheHashesJsonPath = path.join(cachePath, 'hashes.json');

          fs.readFile(cacheHashesJsonPath, 'utf8', (err, s) => {
            if (!err) {
              const newModulesHashesJson = JSON.parse(s);
              this.modulesHashesJson = newModulesHashesJson;

              unlockCb(null, newModulesHashesJson);
            } else if (err.code === 'ENOENT') {
              const newModulesHashesJson = {
                plugins: {},
              };
              this.modulesHashesJson = newModulesHashesJson;

              unlockCb(null, newModulesHashesJson);
            } else {
              unlockCb(err);
            }
          });
        })
        .catch(err => {
          cb(err);
        });
    }
  }

  saveModulesHashesJson(cb) {
    const {dirname, installDirectory, moduleHashesMutex, modulesHashesJson} = this;

    this.loadModulesHashesJson((err, modulesHashesJson) => {
      if (!err) {
        moduleHashesMutex.lock(MODULE_HASHES_MUTEX_KEY)
          .then(unlock => {
            const unlockCb = (err, result) => {
              cb(err, result);

              unlock();
            };

            const cachePath = path.join(dirname, installDirectory, 'cache');

            mkdirp(cachePath, err => {
              if (!err) {
                const cacheHashesJsonPath = path.join(cachePath, 'hashes.json');

                fs.writeFile(cacheHashesJsonPath, JSON.stringify(modulesHashesJson, null, 2), err => {
                  if (!err) {
                    unlockCb();
                  } else {
                    unlockCb(err);
                  }
                });
              } else {
                unlockCb(err);
              }
            });
          })
          .catch(err => {
            cb(err);
          });
      } else {
        cb(err);
      }
    });
  }

  setModuleHash(moduleName, hash, cb) {
    this.loadModulesHashesJson((err, modulesHashesJson) => {
      if (!err) {
        modulesHashesJson[moduleName] = hash;

        this.saveModulesHashesJson(cb);
      } else {
        cb(err);
      }
    });
  }

  unsetModuleHash(moduleName, cb) {
    this.loadModulesHashesJson((err, modulesHashesJson) => {
      if (!err) {
        delete modulesHashesJson[moduleName];

        this.saveModulesHashesJson(cb);
      } else {
        cb(err);
      }
    });
  }

  setValidatedModuleHash(moduleName, hash) {
    const {validatedModuleHashes} = this;
    validatedModuleHashes[moduleName] = hash;
  }

  unsetValidatedModuleHash(moduleName) {
    const {validatedModuleHashes} = this;
    delete validatedModuleHashes[moduleName];
  }

  requestInstalledModuleHash(moduleName) {
    return new Promise((accept, reject) => {
      this.loadModulesHashesJson((err, modulesHashesJson) => {
        if (!err) {
          accept(modulesHashesJson[moduleName] || null);
        } else {
          reject(err);
        }
      });
    });
  }

  requestInstallCandidateModuleHash(module) {
    return new Promise((accept, reject) => {
      const {pather} = this;

      if (path.isAbsolute(module)) {
        const modulePath = pather.getLocalModulePath(module);

        const hasher = fsHasher.watch(modulePath, newHash => {
          accept(newHash);

          hasher.destroy();
        });
      } else {
        https.get({
          hostname: 'api.npms.io',
          path: '/v2/package/' + module,
        }, res => {
          const bs = [];
          res.on('data', d => {
            bs.push(d);
          });
          res.on('end', () => {
            const b = Buffer.concat(bs);
            const s = b.toString('utf8');
            const j = JSON.parse(s);
            const {collected: {metadata: {version}}} = j;

            accept(version);
          });
        }).on('error', err => {
          reject(err);
        });
      }
    });
  }

  getModuleInstallStatus(module, cb) {
    const {pather, validatedModuleHashes} = this;

    pather.getModuleRealName(module, (err, moduleName) => {
      if (!err) {
        const validatedHash = validatedModuleHashes[moduleName] || null;

        if (validatedHash !== null) {
          const exists = true;
          const outdated = false;
          const installedHash = validatedHash;
          const candidateHash = validatedHash;

          cb(null, {exists, outdated, moduleName, installedHash, candidateHash});
        } else {
          Promise.all([
            this.requestInstalledModuleHash(moduleName),
            this.requestInstallCandidateModuleHash(module),
          ])
            .then(([
              installedHash,
              candidateHash,
            ]) => {
              const exists = installedHash !== null;
              const outdated = !exists || installedHash !== candidateHash;

              cb(null, {module, moduleName, exists, outdated, installedHash, candidateHash});
            })
            .catch(err => {
              cb(err);
            });
        }
      } else {
        cb(err);
      }
    });
  }
}

class ArchaeInstaller {
  constructor(dirname, installDirectory, pather, hasher) {
    this.dirname = dirname;
    this.installDirectory = installDirectory;
    this.pather = pather;
    this.hasher = hasher;

    this.running = false;
    this.queue = [];
  }

  addModules(modules, cb) {
    const {dirname, installDirectory, pather} = this;

    const _npmInstall = (moduleSpecs, cb) => {
      const _queue = () => new Promise((accept, reject) => {
        this.queueNpm(unlock => {
          accept(unlock);
        });
      });
      const _install = moduleSpecs => new Promise((accept, reject) => {
        const modulePaths = moduleSpecs.map(moduleSpec => {
          const {module} = moduleSpec;
          if (path.isAbsolute(module)) {
            return path.join(dirname, module);
          } else {
            return module;
          }
        });
        const npmInstall = child_process.spawn(
          npmCommands.install[0],
          npmCommands.install.slice(1).concat(modulePaths),
          {
            cwd: path.join(dirname, installDirectory, 'plugins'),
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

      _queue()
        .then(unlock => {
          const unlockCb = (cb => (err, result) => {
            cb(err, result);

            unlock();
          })(cb);

          _install(moduleSpecs)
            .then(() => {
              unlockCb();
            })
            .catch(err => {
              unlockCb(err);
            });
        })
        .catch(err => {
          cb(err);
        });
    };

    mkdirp(path.join(dirname, installDirectory, 'plugins', 'node_modules'), err => {
      if (!err) {
        const _requestModuleInstallStatuses = modules => Promise.all(modules.map(module => new Promise((accept, reject) => {
          this.hasher.getModuleInstallStatus(module, (err, result) => {
            if (!err) {
              accept(result);
            } else {
              reject(err);
            }
          });
        })));
        const _doRemoves = moduleStatuses => Promise.all(moduleStatuses.map(moduleStatus => new Promise((accept, reject) => {
          const {exists, outdated} = moduleStatus;

          if (exists && outdated) {
            const {moduleName} = moduleStatus;

            this.removeModule(moduleName, err => {
              if (!err) {
                accept();
              } else {
                reject(err);
              }
            });
          } else {
            accept();
          }
        })));
        const _doAdds = moduleStatuses => new Promise((accept, reject) => {
          const moduleStatusesToInstall = moduleStatuses.filter(moduleStatus => {
            const {exists, outdated} = moduleStatus;
            return !exists || outdated;
          });

          if (moduleStatusesToInstall.length > 0) {
            _npmInstall(moduleStatusesToInstall, err => {
              if (!err) {
                accept();
              } else {
                reject(err);
              }
            });
          } else {
            accept();
          }
        });
        const _doUpdateHashes = moduleStatuses => Promise.all(moduleStatuses.map(moduleStatus => new Promise((accept, reject) => {
          const {exists, outdated} = moduleStatus;

          if (!exists || outdated) {
            const {moduleName, candidateHash} = moduleStatus;

            this.hasher.setModuleHash(moduleName, candidateHash, err => {
              if (!err) {
                accept();
              } else {
                reject(err);
              }
            });
          } else {
            accept();
          }
        })));
        const _doValidateHashes = moduleStatuses => new Promise((accept, reject) => {
          for (let i = 0; i < moduleStatuses.length; i++) {
            const moduleStatus = moduleStatuses[i];
            const {moduleName, candidateHash} = moduleStatus;

            this.hasher.setValidatedModuleHash(moduleName, candidateHash);
          }

          accept();
        });

        _requestModuleInstallStatuses(modules)
          .then(moduleStatuses =>
            _doRemoves(moduleStatuses)
              .then(() => _doAdds(moduleStatuses))
              .then(() => _doUpdateHashes(moduleStatuses))
              .then(() => _doValidateHashes(moduleStatuses))
              .then(() => {
                cb();
              })
          )
          .catch(err => {
            cb(err);
          });
      } else {
        cb(err);
      }
    });
  }

  removeModule(moduleName, cb) {
    const {hasher, pather} = this;

    hasher.unsetValidatedModuleHash(moduleName);
    hasher.unsetModuleHash(moduleName, err => {
      if (!err) {
        const modulePath = pather.getInstalledModulePath(moduleName);
        rimraf(modulePath, cb);
      } else {
        cb(err);
      }
    });
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

const archae = opts => new ArchaeServer(opts);

module.exports = archae;
