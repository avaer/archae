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
const mkdirp = require('mkdirp');
const rimraf = require('rimraf');
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
  publicDirectory: null,
  dataDirectory: 'data',
  cryptoDirectory: 'crypto',
  installDirectory: 'installed',
  metadata: null,
};

const numCpus = os.cpus().length;
const isWindows = os.platform() === 'win32';
const npmCommands = {
  install: {
    cmd: [
      path.join(__dirname, 'node_modules', 'yarn', 'bin', 'yarn'), 'add',
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

    cors = cors || false;
    this.cors = cors;

    corsOrigin = corsOrigin || '*';
    this.corsOrigin = corsOrigin;

    staticSite = staticSite || false;
    this.staticSite = staticSite;

    this.publicBundlePromise = null;

    const pather = new ArchaePather(dirname, installDirectory);
    this.pather = pather;
    const installer = new ArchaeInstaller(dirname, dataDirectory, installDirectory, pather);
    this.installer = installer;

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
    return new ws.Server({
      noServer: true,
    });
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
        if (hotload && /^\//.test(plugin)) {
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

  getDirectAbsoluteModulePath(moduleFileName) {
    const {dirname, installDirectory} = this;
    return path.join(dirname, installDirectory, 'plugins', moduleFileName);
  }

  getAbsoluteModulePath(module) {
    return this.getDirectAbsoluteModulePath(path.isAbsolute(module) ? module.replace(/\//g, '_') : module);
  }

  requestInstalledModulePath(module) {
    return new Promise((accept, reject) => {
      const {dirname, installDirectory} = this;

      const absolutePath = this.getAbsoluteModulePath(module);
      fs.readFile(path.join(absolutePath, 'package.json'), 'utf8', (err, s) => {
        if (!err) {
          const j = JSON.parse(s);
          const {dependencies} = j;
          const keys = Object.keys(dependencies);

          if (keys.length > 0) {
            accept(path.join(absolutePath, 'node_modules', keys[0]));
          } else {
            reject(null);
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

  requestPluginClient(plugin) {
    return this.requestPackageJsonFileName(plugin, 'client');
  }

  requestPluginBuilds(plugin) {
    return this.requestPackageJsonFileName(plugin, 'builds');
  }
}

class ArchaeInstaller {
  constructor(dirname, dataDirectory, installDirectory, pather, fsHash) {
    this.dirname = dirname;
    this.dataDirectory = dataDirectory;
    this.installDirectory = installDirectory;
    this.pather = pather;
    this.fsHash = fshash({
      basePath: dirname,
      dataPath: path.join(dataDirectory, 'mod-hashes.json'),
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
            npmCommands.install.cmd[0],
            npmCommands.install.cmd.slice(1).concat([
              modulePath,
              '--production',
              '--mutex', 'file:' + path.join(os.tmpdir(), '.archae-yarn-lock'),
            ]),
            {
              cwd: path.join(pather.getAbsoluteModulePath(module)),
              shell: isWindows,
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
                if (Array.isArray(buildFileNames)) {
                  return Promise.all(buildFileNames.map(buildFileName => {
                    const srcPath = buildFileName;
                    const dstPath = path.join(pather.getAbsoluteModulePath(module), '.archae', 'build', buildFileName);

                    return _requestRollup(srcPath)
                      .then(code => _writeFile(dstPath, code));
                  }));
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
