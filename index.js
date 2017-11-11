const events = require('events');
const {EventEmitter} = events;
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const child_process = require('child_process');
const os = require('os');

const spdy = require('spdy');
const express = require('express');
const ws = require('ws');
const etag = require('etag');
const httpAuth = require('http-auth');
const mkdirp = require('mkdirp');
const rimraf = require('rimraf');
const getport = require('getport');
const rollup = require('rollup');
const rollupPluginNodeResolve = require('rollup-plugin-node-resolve');
const rollupPluginCommonJs = require('rollup-plugin-commonjs');
const rollupPluginJson = require('rollup-plugin-json');
const watchr = require('watchr');
const cryptoutils = require('cryptoutils');
const MultiMutex = require('multimutex');
const fshash = require('fshash');

const defaultConfig = {
  hostname: 'archae',
  altHostnames: [],
  host: null,
  port: 8000,
  secure: false,
  hotload: true,
  publicDirectory: null,
  dataDirectory: 'data',
  cryptoDirectory: 'crypto',
  installDirectory: 'installed',
  indexJsFiles: [],
  password: null,
  metadata: null,
};

const numCpus = os.cpus().length;
const npmCommands = {
  install: {
    cmd: [
      path.join(require.resolve('yarn-zeo'), '..', 'bin', 'yarn.js'), 'add',
    ],
  },
};
const pathSymbol = Symbol();

class ArchaeServer extends EventEmitter {
  constructor({
    dirname,
    hostname,
    host,
    port,
    secure,
    hotload,
    publicDirectory,
    dataDirectory,
    cryptoDirectory,
    installDirectory,
    indexJsFiles,
    metadata,
    server,
    app,
    wss,
    generateCerts,
    password,
    locked,
    cors,
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

    hotload = (typeof hotload === 'boolean') ? hotload : defaultConfig.hotload;
    this.hotload = hotload;

    publicDirectory = publicDirectory || defaultConfig.publicDirectory;
    this.publicDirectory = publicDirectory;

    dataDirectory = dataDirectory || defaultConfig.dataDirectory;
    this.dataDirectory = dataDirectory;

    cryptoDirectory = cryptoDirectory || defaultConfig.cryptoDirectory;
    this.cryptoDirectory = cryptoDirectory;

    installDirectory = installDirectory || defaultConfig.installDirectory;
    this.installDirectory = installDirectory;

    indexJsFiles = indexJsFiles || defaultConfig.indexJsFiles;
    this.indexJsFiles = indexJsFiles;

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

    password = (typeof password === 'string') ? password : defaultConfig.password;
    this.password = password;

    locked = locked || false;
    this.locked = locked;

    cors = cors || false;
    this.cors = cors;

    staticSite = staticSite || false;
    this.staticSite = staticSite;

    this.publicBundlePromise = null;

    const pather = new ArchaePather(dirname, installDirectory);
    this.pather = pather;
    const installer = new ArchaeInstaller(dirname, dataDirectory, installDirectory, pather, hotload);
    this.installer = installer;

    const auther = (() => {
      const httpBasicAuth = httpAuth.connect(httpAuth.basic({
        realm: 'Zeo',
      }, (u, p, cb) => {
        cb(p === this.password);
      }));

      return (req, res, next) => {
        if (!/^(?:::ffff:)?127\.0\.0\.1$/.test(req.connection.remoteAddress) && this.password !== null) {
          httpBasicAuth(req, res, next);
        } else {
          next();
        }
      };
    })();
    this.auther = auther;

    this.connections = [];

    this.plugins = {};
    this.pluginInstances = {};
    this.pluginApis = {};
    this.watchers = {};
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
    const wss = new ws.Server({
      noServer: true,
    });
    wss.setMaxListeners(100);
    return wss;
  }

  requestPlugin(plugin, {force = false, hotload = false} = {}) {
    return this.requestPlugins([plugin], {force, hotload})
      .then(([plugin]) => Promise.resolve(plugin));
  }

  installPlugins(plugins, {force = false} = {}) {
    return new Promise((accept, reject) => {
      const {installer} = this;

      installer.addModules(plugins, force, err => {
        if (!err) {
          accept();
        } else {
          reject(err);
        }
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
          return Promise.resolve();
        }
      };
      const _bootPlugins = plugins => Promise.all(plugins.map(plugin => new Promise((accept, reject) => {
        const cb = (err, result) => {
          if (!err) {
            accept(result);
          } else {
            reject(err);
          }
        };

        this.loadsMutex.lock(plugin)
          .then(unlock => {
            this.watchPlugin(plugin, {hotload});

            this.loadPlugin(plugin, err => {
              if (!err) {
                this.mountsMutex.lock(plugin)
                  .then(unlock => {
                    this.mountPlugin(plugin, err => {
                      if (!err) {
                        cb(null, this.pluginApis[plugin]);
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

      _installPlugins(plugins)
        .then(() => _bootPlugins(plugins))
        .then(pluginApis => {
          cb(null, pluginApis);
        })
        .catch(err => {
          cb(err);
        });
    });
  }

  releasePlugin(plugin) {
    const {pather} = this;

    return this.mountsMutex.lock(plugin)
      .then(unlock => new Promise((accept, reject) => {
        this.unmountPlugin(plugin, err => {
          if (!err) {
            this.unloadPlugin(plugin);

            this.unwatchPlugin(plugin);

            accept(plugin);
          } else {
            reject(err);
          }

          unlock();
        });
      }));
  }

  releasePlugins(plugins) {
    const releasePluginPromises = plugins.map(plugin => this.releasePlugin(plugin));
    return Promise.all(releasePluginPromises);
  }

  removePlugin(plugin) {
    const {installer} = this;

    return this.releasePlugin(plugin)
      .then(() => new Promise((accept, reject) => {
        installer.removeModule(plugin, err => {
          if (!err) {
            accept();
          } else {
            reject(err);
          }
        })
      }));
  }

  removePlugins(plugins) {
    return Promise.all(plugins.map(plugin => this.removePlugin(plugin)));
  }

  getLoadedPlugins() {
    return Object.keys(this.plugins).sort();
  }

  loadPlugin(plugin, cb) {
    const {pather} = this;

    const existingPlugin = this.plugins[plugin];

    if (existingPlugin !== undefined) {
      cb();
    } else {
      pather.requestPackageJsonFileName(plugin, 'server')
        .then(fileName => {
          if (fileName) {
            const moduleInstance = require(fileName);
            this.plugins[plugin] = moduleInstance;
          } else {
            this.plugins[plugin] = null;
          }

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

  watchPlugin(plugin, {hotload}) {
    if (this.watchers[plugin] === undefined) {
      const watcher = (() => {
        if (this.hotload && hotload && /^\//.test(plugin)) {
          const {dirname} = this;
          const moduleDirectoryPath = path.join(dirname, plugin);
          const watcher = new watchr.Watcher(moduleDirectoryPath);
          watcher.setConfig({
            catchupDelay: 100,
          });
          const change = (/*changeType, fullPath, currentStat, previousStat*/) => {
            this.broadcast('unload', plugin);

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

  mountPlugin(plugin, cb) {
    const existingPluginApi = this.pluginApis[plugin];

    if (existingPluginApi !== undefined) {
      cb();
    } else {
      const moduleRequire = this.plugins[plugin];

      if (moduleRequire !== null) {
        Promise.resolve(_instantiate(moduleRequire, this))
          .then(pluginInstance => {
            this.pluginInstances[plugin] = pluginInstance;
            pluginInstance[pathSymbol] = plugin;

            Promise.resolve(pluginInstance.mount())
              .then(pluginApi => {
                if (typeof pluginApi !== 'object' || pluginApi === null) {
                  pluginApi = {};
                }

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
        this.pluginInstances[plugin] = {
          [pathSymbol]: plugin,
        };
        this.pluginApis[plugin] = {};
        cb();
      }
    }
  }

  unmountPlugin(plugin, cb) {
    const pluginInstance = this.pluginInstances[plugin];

    if (pluginInstance !== undefined) {
      const _cleanup = () => {
        for (const p in require.cache) {
          const module = require.cache[p];
          const {exports} = module;

          if (exports === pluginInstance) {
            delete require.cache[p];
          }
        }

        delete this.pluginInstances[plugin];
        delete this.pluginApis[plugin];
      };

      Promise.resolve(typeof pluginInstance.unmount === 'function' ? pluginInstance.unmount() : null)
        .then(() => {
          _cleanup();

          cb();
        })
        .catch(err => {
          console.warn(err);

          _cleanup();

          cb();
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

  getPath(pluginInstance) {
    return pluginInstance ? pluginInstance[pathSymbol] : null;
  }

  mountApp() {
    const {hostname, dirname, publicDirectory, installDirectory, metadata, server, app, wss, cors, staticSite, pather, auther} = this;

    // cross-origin resoure sharing
    if (cors) {
      app.all('*', (req, res, next) => {
        res.set('Access-Control-Allow-Origin', req.get('Host'));
        res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        res.set('Access-Control-Allow-Credentials', 'true');

        next();
      });
    }

    // password
    app.all('*', auther);

    // user public
    if (publicDirectory) {
      app.use('/', express.static(path.join(dirname, publicDirectory)));
    }

    class FakeResponse {
      constructor(socket) {
        this.socket = socket;
      }
      setHeader() {}
      writeHead() {}
      end() {
        return this.socket.end();
      }
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
        auther(req, new FakeResponse(socket), () => {
          const upgradeEvent = new UpgradeEvent(req, socket, head);
          wss.emit('upgrade', upgradeEvent);

          if (upgradeEvent.isLive()) {
            wss.handleUpgrade(req, socket, head, c => {
              wss.emit('connection', c, req);
            });
          }
        });
      } else {
        socket.destroy();
      }
    });

    if (!staticSite) {
      // archae public
      app.get('/archae/index.js', (req, res, next) => {
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
        res.json(this.getLoadedPlugins());
      });

      // archae bundles
      const _serveJsFile = (req, res, {module, build = null}) => {
        const srcPath = path.join(pather.getDirectAbsoluteModulePath(module), '.archae', (build ? path.join('build', build) : 'client') + '.js');

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

      wss.on('connection', (c, {url}) => {
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
                  .then(() => pather.requestPluginClient(plugin)
                    .then(clientFileName => {
                      const hasClient = Boolean(clientFileName);

                      return {
                        plugin,
                        hasClient,
                      };
                    })
                  )
                  .then(pluginSpecs => {
                    cb(null, pluginSpecs);
                  })
                  .catch(err => {
                    cb(err);
                  });
              } else if (method === 'requestPlugins') {
                const {plugins, force, hotload} = args;

                this.requestPlugins(plugins, {force, hotload})
                  .then(() =>
                    Promise.all(plugins.map(plugin =>
                      pather.requestPluginClient(plugin)
                        .then(clientFileName => {
                          const hasClient = Boolean(clientFileName);

                          return {
                            plugin,
                            hasClient,
                          };
                        })
                    ))
                  )
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
      this.publicBundlePromise = _requestRollup([
        path.join(__dirname, 'lib', 'archae.js'),
      ].concat(this.indexJsFiles))
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
      const {port} = this;

      getport(port, (err, port) => {
        if (!err) {
          this.port = port;
          const {host, server} = this;

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
        } else {
          reject(err);
        }
      });
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

  getDirectAbsoluteModulePath(moduleFileName) {
    const {dirname, installDirectory} = this;
    return path.join(dirname, installDirectory, 'plugins', moduleFileName);
  }

  getAbsoluteModulePath(module) {
    return this.getDirectAbsoluteModulePath(path.isAbsolute(module) ? module.replace(/[\/\\]/g, '_') : module);
  }

  requestInstalledModulePath(module) {
    return new Promise((accept, reject) => {
      const {dirname, installDirectory} = this;

      const absolutePath = this.getAbsoluteModulePath(module);
      fs.readFile(path.join(absolutePath, 'package.json'), 'utf8', (err, s) => {
        if (!err) {
          const j = JSON.parse(s);
          if (j && j.dependencies && typeof j.dependencies === 'object') {
            const {dependencies} = j;
            const keys = Object.keys(dependencies);

            if (keys.length > 0) {
              accept(path.join(absolutePath, 'node_modules', keys[0]));
            } else {
              const err = new Error('module package.json corrupted: ' + JSON.stringify({module, absolutePath, packageJson: j}));
              reject(err);
            }
          } else {
            const err = new Error('module package.json corrupted: ' + JSON.stringify({module, absolutePath, packageJson: j}));
            reject(err);
          }
        } else {
          reject(err);
        }
      });
    });
  }

  getLocalModulePath(module) {
    const {dirname} = this;
    return path.join(dirname, module);
  }

  getLocalModulePackageJsonPath(module) {
    return path.join(this.getLocalModulePath(module), 'package.json');
  }

  requestPackageJsonFileName(plugin, packageJsonFileNameKey) {
    const {dirname, installDirectory} = this;

    return this.requestInstalledModulePath(plugin)
      .then(installedPath => new Promise((accept, reject) => {
        const packageJsonPath = path.join(installedPath, 'package.json');

        fs.readFile(packageJsonPath, 'utf8', (err, s) => {
          if (!err) {
            const j = JSON.parse(s);
            const fileName = j[packageJsonFileNameKey];
            const fullPath = typeof fileName === 'string' ? path.join(installedPath, fileName) : null;
            accept(fullPath);
          } else {
            reject(err);
          }
        });
      }));
  }

  requestPackageJsonFileNames(plugin, packageJsonFileNamesKey) {
    const {dirname, installDirectory} = this;

    return this.requestInstalledModulePath(plugin)
      .then(installedPath => new Promise((accept, reject) => {
        const packageJsonPath = path.join(installedPath, 'package.json');

        fs.readFile(packageJsonPath, 'utf8', (err, s) => {
          if (!err) {
            const j = JSON.parse(s);
            const o = j[packageJsonFileNamesKey];

            if (typeof o === 'object') {
              const fileNames = Object.keys(o).map(dst => ({
                src: path.join(installedPath, o[dst]),
                dst: dst,
              }));
              accept(fileNames);
            } else {
              accept(null);
            }
          } else {
            reject(err);
          }
        });
      }));
  }

  requestPluginClient(plugin) {
    return this.requestPackageJsonFileName(plugin, 'client');
  }

  requestPluginBuilds(plugin) {
    return this.requestPackageJsonFileNames(plugin, 'builds');
  }
}

class ArchaeInstaller {
  constructor(dirname, dataDirectory, installDirectory, pather, hotload) {
    this.dirname = dirname;
    this.dataDirectory = dataDirectory;
    this.installDirectory = installDirectory;
    this.pather = pather;
    this.fsHash = hotload ? fshash({
      basePath: dirname,
      dataPath: path.join(dataDirectory, 'mod-hashes.json'),
    }) : _makeFakeFsHash({
      basePath: dirname,
      pather,
    });

    this.numTickets = numCpus;
    this.queue = [];
  }

  addModules(modules, force, cb) {
    const {dirname, installDirectory, pather, fsHash} = this;

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

    const _requestTicket = () => new Promise((accept, reject) => {
      const _release = () => {
        const {numTickets} = this;
        this.numTickets = numTickets + 1;

        const {queue} = this;
        if (queue.length > 0) {
          queue.splice(0, 1)[0]();
        }
      };
      const _recurse = () => {
        const {numTickets} = this;
        if (numTickets > 0) {
          this.numTickets = numTickets -1;

          accept(_release);
        } else {
          const {queue} = this;
          queue.push(_recurse);
        }
      };
      _recurse();
    });
    const _requestNpmInstall = modules => {
      return Promise.all(modules.map(module => {
        const _ensurePackageJson = module => _writeFile(path.join(pather.getAbsoluteModulePath(module), 'package.json'), '{}');
        const _install = module => new Promise((accept, reject) => {
          const modulePath = (() => {
            if (path.isAbsolute(module)) {
              return 'file:' + path.join(dirname, module);
            } else {
              return module;
            }
          })();
          const npmInstall = child_process.spawn(
            process.argv[0],
            npmCommands.install.cmd.concat([
              modulePath,
              '--production',
              '--mutex', 'file:' + path.join(os.tmpdir(), '.archae-yarn-lock'),
            ]),
            {
              cwd: path.join(pather.getAbsoluteModulePath(module)),
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
        const _build = module => {
          const _buildClient = () => {
            return pather.requestPluginClient(module)
              .then(clientFileName => {
                if (typeof clientFileName === 'string') {
                  const srcPath = clientFileName;
                  const dstPath = path.join(pather.getAbsoluteModulePath(module), '.archae', 'client.js');

                  return _requestRollup(srcPath)
                    .then(code => _writeFile(dstPath, code))
                } else {
                  return Promise.resolve();
                }
              });
          };
          const _buildBuilds = () => {
            return pather.requestPluginBuilds(module)
              .then(buildFileNames => {
                if (buildFileNames) {
                  return Promise.all(buildFileNames.map(({src, dst}) =>
                    _requestRollup(src)
                      .then(code => _writeFile(path.join(pather.getAbsoluteModulePath(module), '.archae', 'build', dst + '.js'), code))
                  ));
                } else {
                  return Promise.resolve([]);
                }
              });
          };

          return Promise.all([
            _buildClient(),
            _buildBuilds(),
          ]);
        };

        return _requestTicket()
          .then(release => {
            return _ensurePackageJson(module)
              .then(() => _install(module))
              .then(() => _build(module))
              .then(() => {
                release();
              })
              .catch(err => {
                release();

                return Promise.reject(err);
              });
          });
      }));
    };

    fsHash.updateAll(modules, modules => _requestNpmInstall(modules))
      .then(() => {
        cb();
      })
      .catch(err => {
        cb(err);
      });
  }

  removeModule(module, cb) {
    const {pather, fsHash} = this;

    fsHash.remove(module, () => new Promise((accept, reject) => {
      rimraf(pather.getAbsoluteModulePath(module), err => {
        if (!err) {
          accept();
        } else {
          reject(err);
        }
      });
    }))
      .then(() => {
        cb();
      })
      .catch(err => {
        cb(err);
      });
  }
}

const _makeFakeFsHash = ({basePath, pather}) => ({
  updateAll: (ps, fn) => {
    ps = ps.slice().sort();

    const promises = [];
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      promises.push(
        _requestExists(pather.getAbsoluteModulePath(p))
          .then(exists => !exists ? p : null)
      );
    }
    return Promise.all(promises)
      .then(paths => Promise.resolve(fn(paths.filter(p => p !== null))))
      .then(() => {});
  },
  remove: (p, fn) => Promise.resolve(fn(p)),
});
const _requestExists = p => new Promise((accept, reject) => {
  fs.lstat(p, err => {
    if (!err) {
      accept(true);
    } else {
      if (err.code === 'ENOENT') {
        accept(false);
      } else {
        reject(err);
      }
    }
  });
});
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
const _requestRollup = p => {
  const ps = Array.isArray(p) ? p : [p];

  return Promise.all(ps.map(p =>
    rollup.rollup({
      input: p,
      plugins: [
        rollupPluginNodeResolve({
          main: true,
          preferBuiltins: false,
        }),
        rollupPluginCommonJs(),
        rollupPluginJson(),
      ],
    })
      .then(bundle => bundle.generate({
        name: module,
        format: 'cjs',
        strict: false,
      }))
      .then(({code}) => code)
  ))
    .then(codes => '(function() {\n' + codes.join('\n') + '\n})();\n');
};

const archae = opts => new ArchaeServer(opts);
module.exports = archae;
