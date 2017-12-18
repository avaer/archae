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
  pluginsDirectory: 'plugins',
  dataDirectory: 'data',
  cryptoDirectory: 'crypto',
  installDirectory: 'data/installed',
  indexJsPrefix: '',
  indexJsFiles: [],
  password: null,
  metadata: null,
};

const numCpus = (() => {
  const webConcurrency = parseInt(process.env['WEB_CONCURRENCY'], 10);
  return webConcurrency > 0 ? webConcurrency : os.cpus().length;
})();
const npmCommands = {
  install: {
    cmd: [
      'node', path.join(require.resolve('yarn-zeo'), '..', 'bin', 'yarn.js'), 'add',
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
    pluginsDirectory,
    dataDirectory,
    cryptoDirectory,
    installDirectory,
    indexJsPrefix,
    indexJsFiles,
    metadata,
    server,
    app,
    wss,
    generateCerts,
    password,
    locked,
    cors,
    offline,
    offlinePlugins,
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

    pluginsDirectory = pluginsDirectory || defaultConfig.pluginsDirectory;
    this.pluginsDirectory = pluginsDirectory;

    dataDirectory = dataDirectory || defaultConfig.dataDirectory;
    this.dataDirectory = dataDirectory;

    cryptoDirectory = cryptoDirectory || defaultConfig.cryptoDirectory;
    this.cryptoDirectory = cryptoDirectory;

    installDirectory = installDirectory || defaultConfig.installDirectory;
    this.installDirectory = installDirectory;

    indexJsPrefix = indexJsPrefix || defaultConfig.indexJsPrefix;
    this.indexJsPrefix = indexJsPrefix;

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

    offline = offline || false;
    this.offline = offline;

    offlinePlugins = offlinePlugins || [];
    this.offlinePlugins = offlinePlugins;

    staticSite = staticSite || false;
    this.staticSite = staticSite;

    this.publicBundlePromise = null;

    const pather = new ArchaePather(dirname, pluginsDirectory, installDirectory);
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

  requestPlugin(plugin, {force = false, hotload = false, offline = false} = {}) {
    return this.requestPlugins([plugin], {force, hotload, offline})
      .then(([plugin]) => Promise.resolve(plugin));
  }

  installPlugins(plugins, {force = false} = {}) {
    return new Promise((accept, reject) => {
      this.installer.addModules(plugins, force, err => {
        if (!err) {
          accept();
        } else {
          reject(err);
        }
      });
    });
  }

  requestPlugins(plugins, {force = false, hotload = false, offline = false} = {}) {
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
            this.watchPlugin(plugin, {hotload}, err => {
              if (!err) {
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
              } else {
                cb(err);

                unlock();
              }
            });
          })
          .catch(err => {
            cb(err);
          });
      })));

      _installPlugins(plugins)
        .then(() => {
          if (!offline) {
            return _bootPlugins(plugins);
          } else {
            return Promise.resolve(plugins);
          }
        })
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

  watchPlugin(plugin, {hotload}, cb) {
    const {pather} = this;

    if (this.watchers[plugin] === undefined && this.hotload && hotload) {
      pather.requestModulePath(plugin)
        .then(pluginPath => {
          const match = pluginPath.match(/^file:(.+)$/);
          if (match) {
            pluginPath = match[1];

            const watcher = new watchr.Watcher(pluginPath);
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
            this.watchers[plugin] = watcher;
          }

          cb();
        })
        .catch(err => {
          cb(err);
        });
    } else {
      cb();
    }
  }

  unwatchPlugin(plugin) {
    const watcher = this.watchers[plugin];
    if (watcher) {
      watcher.close();
    }
    delete this.watchers[plugin];
  }

  requestPluginPackageJson(plugin) {
    return new Promise((accept, reject) => {
      const srcPath = path.join(this.pather.getAbsoluteModulePath(plugin), 'node_modules', this.pather.getModuleName(plugin), 'package.json');
      fs.readFile(srcPath, 'utf8', (err, d) => {
        if (!err) {
          accept(d);
        } else if (err.code === 'ENOENT') {
          accept(null);
        } else {
          reject(err);
        }
      });
    });
  }

  requestPluginBundle(plugin) {
    return new Promise((accept, reject) => {
      const srcPath = path.join(this.pather.getAbsoluteModulePath(plugin), '.archae', 'client.js');
      fs.readFile(srcPath, 'utf8', (err, codeString) => {
        if (!err) {
          accept(codeString);
        } else if (err.code === 'ENOENT') {
          accept(null);
        } else {
          reject(err);
        }
      });
    });
  }

  requestPluginServe(plugin, serve) {
    return new Promise((accept, reject) => {
      const srcPath = path.join(this.pather.getAbsoluteModulePath(plugin), '.archae', 'serve', serve);
      fs.readFile(srcPath, (err, d) => {
        if (!err) {
          accept(d);
        } else if (err.code === 'ENOENT') {
          accept(null);
        } else {
          reject(err);
        }
      });
    });
  }

  requestPluginBuild(plugin, build) {
    return new Promise((accept, reject) => {
      const srcPath = path.join(this.pather.getAbsoluteModulePath(plugin), '.archae', (build ? path.join('build', build) : 'client') + '.js');
      fs.readFile(srcPath, (err, d) => {
        if (!err) {
          accept(d);
        } else if (err.code === 'ENOENT') {
          accept(null);
        } else {
          reject(err);
        }
      });
    });
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
        res.set('Access-Control-Allow-Origin', '*');
        res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        res.set('Access-Control-Allow-Credentials', 'true');

        next();
      });
    }

    // ping
    app.get('/ping', (req, res, next) => {
      res.end('pong');
    });

    // password
    app.all('*', auther);

    // user public
    if (publicDirectory) {
      app.use('/', express.static(path.join(dirname, publicDirectory)));
    }

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

    // archae bundles
    const _serveFile = (req, res, {module, serve}) => this.requestPluginServe(module, serve)
      .then(d => {
        if (d !== null) {
          res.type(serve);

          const et = etag(d);

          if (req.get('If-None-Match') === et) {
            res.status(304);
            res.send();
          } else {
            res.set('Etag', et);
            res.send(d);
          }
        } else {
          res.status(404);
          res.end(http.STATUS_CODES[404]);
        }
      })
      .catch(err => {
        res.status(500);
        res.end(err.stack);
      });
    const _serveJsFile = (req, res, {module, build = null}) => this.requestPluginBuild(module, build)
      .then(d => {
        if (d !== null) {
          res.type('application/javascript');

          const et = etag(d); // XXX these can be precomputed

          if (req.get('If-None-Match') === et) {
            res.status(304);
            res.send();
          } else {
            res.set('Etag', et);
            res.send(d);
          }
        } else {
          res.status(404);
          res.end(http.STATUS_CODES[404]);
        }
      })
      .catch(err => {
        res.status(500);
        res.end(err.stack);
      });

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
    app.get(/^\/archae\/plugins\/([^\/]+?)\/serve\/(.+)$/, (req, res, next) => {
      const {params} = req;
      const module = params[0];
      const serve = params[1];

      if (!/\.\./.test(serve)) {
        _serveFile(req, res, {
          module,
          serve,
        });
      } else {
        res.status(400);
        res.send();
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

    if (!staticSite) {
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

      // archae lists
      /* app.use('/archae/plugins.json', (req, res, next) => {
        res.json(this.getLoadedPlugins());
      }); */

      server.on('upgrade', (req, socket, head) => {
        auther(req, new FakeResponse(socket), () => {
          const upgradeEvent = new UpgradeEvent(req, socket, head);
          wss.emit('upgrade', upgradeEvent);

          if (upgradeEvent.isLive()) {
            wss.handleUpgrade(req, socket, head, c => {
              wss.emit('connection', c, req);
            });
          }
        });
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

  ensurePublicBundlePromise() {
    this.publicBundlePromise = _requestRollup([
      path.join(__dirname, 'lib', 'archae.js'),
    ].concat(this.indexJsFiles))
      .then(codeString => {
        if (this.offline) {
          return this.requestPlugins(this.offlinePlugins, {offline: true})
            .then(() => Promise.all(
              this.offlinePlugins.map(plugin =>
                new Promise((accept, reject) => {
                  const srcPath = path.join(this.pather.getAbsoluteModulePath(plugin), '.archae', 'client.js');
                  fs.readFile(srcPath, 'utf8', (err, codeString) => {
                    if (!err) {
                      accept({
                        plugin,
                        codeString,
                      });
                    } else if (err.code === 'ENOENT') {
                      accept(null);
                    } else {
                      reject(err);
                    }
                  });
                })
              )
            ))
            .then(offlinePluginsCodes => offlinePluginsCodes.filter(offlinePluginsCode => offlinePluginsCode !== null))
            .then(offlinePluginsCodes =>
              `window.metadata = ${JSON.stringify(this.metadata, null, 2)};\n` +
              this.indexJsPrefix +
              `window.offline = true;\n` +
              `window.plugins = {};\n` +
              `window.module = {};\n` +
              offlinePluginsCodes.map(({plugin, codeString}) =>
                codeString +
                `window.plugins[${JSON.stringify(plugin)}] = window.module.exports;\n`
              ).join('') +
              codeString
            );
        } else {
          return Promise.resolve(
            `window.metadata = ${JSON.stringify(this.metadata, null, 2)};\n` +
            this.indexJsPrefix +
            codeString
          );
        }
      })
      .then(codeString => {
        const codeObject = new String(codeString);
        codeObject.etag = etag(codeString);
        return Promise.resolve(codeObject);
      })
      .catch(err => {
        console.warn(err);
      });

    return Promise.resolve();
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

    this.ensurePublicBundlePromise()
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
  constructor(dirname, pluginsDirectory, installDirectory) {
    this.dirname = dirname;
    this.pluginsDirectory = pluginsDirectory;
    this.installDirectory = installDirectory;
  }

  getModuleName(module) {
    return module
      .replace(/(?!^)@.*$/, '')
      .replace(/^.+\/([^\/]+)$/, '$1');
  }

  getCleanModuleName(module) {
    return module.replace(/[\/\\]/g, '_');
  }

  getDirectAbsoluteModulePath(moduleFileName) {
    const {dirname, installDirectory} = this;
    return path.join(dirname, installDirectory, 'plugins', moduleFileName);
  }

  getAbsoluteModulePath(module) {
    return this.getDirectAbsoluteModulePath(path.isAbsolute(module) ? this.getCleanModuleName(module) : this.getModuleName(module));
  }

  requestModulePath(module) {
    const {dirname, pluginsDirectory} = this;

    if (path.isAbsolute(module)) {
      return Promise.resolve('file:' + path.join(dirname, module));
    } else {
      return new Promise((accept, reject) => {
        const moduleName = this.getModuleName(module);
        fs.lstat(path.join(dirname, pluginsDirectory, moduleName, 'package.json'), err => {
          if (!err) {
            accept('file:' + path.join(dirname, pluginsDirectory, moduleName));
          } else if (err.code === 'ENOENT') {
            accept(module);
          } else {
            reject(err);
          }
        });
      });
    }
  }

  requestInstalledModulePath(module) {
    return Promise.resolve(path.join(this.getAbsoluteModulePath(module), 'node_modules', this.getModuleName(module)));
  }

  getLocalModulePath(module) {
    return path.join(this.dirname, module);
  }

  getLocalModulePackageJsonPath(module) {
    return path.join(this.getLocalModulePath(module), 'package.json');
  }

  requestPackageJsonFileName(plugin, packageJsonFileNameKey) {
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

  requestPluginServes(plugin) {
    return this.requestPackageJsonFileNames(plugin, 'serves');
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
    this.hotload = hotload;

    this.fsHash = hotload ? fshash({
      dirname,
      dataPath: path.join(dataDirectory, 'mod-hashes.json'),
    }) : _makeFakeFsHash({
      pather,
    });

    this.numTickets = numCpus;
    this.queue = [];
  }

  addModules(modules, force, cb) {
    const {dirname, installDirectory, pather, hotload, fsHash} = this;

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
    const _requestNpmInstall = (modules, modulePaths) => Promise.all(modules.map((module, index) => {
      const modulePath = modulePaths[index];

      const _ensurePackageJson = () => _writeFile(path.join(pather.getAbsoluteModulePath(module), 'package.json'), '{}');
      const _install = () => new Promise((accept, reject) => {
        const npmInstall = child_process.spawn(
          npmCommands.install.cmd[0],
          npmCommands.install.cmd.slice(1).concat([
            modulePath,
            '--production',
            '--mutex', 'file:' + path.join(os.tmpdir(), '.archae-yarn-lock'),
          ]),
          {
            cwd: path.join(pather.getAbsoluteModulePath(module)),
            env: process.env,
          }
        );
        npmInstall.stdout.pipe(process.stderr);
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
      const _build = () => {
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
        const _copyServes = () => {
          return pather.requestPluginServes(module)
            .then(serveFileNames => {
              if (serveFileNames) {
                return Promise.all(serveFileNames.map(({src, dst}) =>
                  _copyFile(src, path.join(pather.getAbsoluteModulePath(module), '.archae', 'serve', dst))
                ));
              } else {
                return Promise.resolve([]);
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
          _copyServes(),
          _buildBuilds(),
        ]);
      };

      return _requestTicket()
        .then(release => {
          return _ensurePackageJson()
            .then(() => _install())
            .then(() => _build())
            .then(() => {
              release();
            })
            .catch(err => {
              release();

              return Promise.reject(err);
            });
        });
    }));

    if (hotload) {
      Promise.all(modules.map(module => pather.requestModulePath(module)))
        .then(modulePaths => {
          const rawModulePaths = modulePaths.map(modulePath => {
            const match = modulePath.match(/^file:(.+)$/);
            if (match) {
              return match[1].replace(dirname, '');
            } else {
              return modulePath;
            }
          });

          return fsHash.updateAll(rawModulePaths, bits => _requestNpmInstall(
            modules.filter((module, index) => bits[index]),
            modulePaths.filter((modulePath, index) => bits[index])
          ), {
            force,
          });
        })
        .then(() => {
          cb();
        })
        .catch(err => {
          cb(err);
        });
    } else {
      const _requestInstalledModulePaths = ps => Promise.all(ps.map(_requestInstalledModulePath));
      const _requestInstalledModulePath = p => (() => {
        if (path.isAbsolute(p)) {
          return Promise.resolve(p);
        } else {
          return pather.requestModulePath(p)
            .then(p => {
              const match = p.match(/^file:(.+)$/);

              if (match) {
                const packageJsonPath = path.join(match[1], 'package.json');

                return _readFile(packageJsonPath, 'utf8')
                  .then(s => JSON.parse(s).name);
              } else {
                return Promise.resolve(p);
              }
            });
        }
      })()
      .then(p => pather.getAbsoluteModulePath(p));

      Promise.all([
        Promise.all(modules.map(module => pather.requestModulePath(module))),
        _requestInstalledModulePaths(modules),
      ])
        .then(([
          modulePaths,
          installedModulePaths,
        ]) => {
          return Promise.all(installedModulePaths.map(p =>
            _requestExists(p)
              .then(exists => !exists)
          ))
            .then(bits => _requestNpmInstall(
              modules.filter((module, index) => bits[index]),
              modulePaths.filter((modulePath, index) => bits[index])
            ));
        })
        .then(() => {
          cb();
        })
        .catch(err => {
          cb(err);
        });
    }
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

const _makeFakeFsHash = ({pather}) => ({
  updateAll: (ps, fn) => {
    ps = ps.slice().sort();

    return Promise.all(ps.map(p => fn(p)))
      .then(() => {});
  },
  remove: (p, fn) => Promise.resolve(fn(p)),
});
const _readFile = (p, opts) => new Promise((accept, reject) => {
  fs.readFile(p, opts, (err, data) => {
    if (!err) {
      accept(data);
    } else {
      reject(err);
    }
  });
});
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
const _copyFile = (s, d) => new Promise((accept, reject) => {
  mkdirp(path.dirname(d), err => {
    if (!err) {
      fs.copyFile(s, d, err => {
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
