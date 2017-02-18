const path = require('path');
const fs = require('fs');
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
  host: null,
  port: 8000,
  publicDirectory: null,
  dataDirectory: 'data',
  cryptoDirectory: 'crypto',
  installDirectory: 'installed',
  metadata: null,
};

const npmCommands = {
  install: ['npm', 'install'],
};
const nameSymbol = Symbol();

class ArchaeServer {
  constructor({dirname, hostname, host, port, publicDirectory, dataDirectory, cryptoDirectory, installDirectory, metadata, server, app, wss, staticSite} = {}) {
    dirname = dirname || process.cwd();
    this.dirname = dirname;

    hostname = hostname || defaultConfig.hostname;
    this.hostname = hostname;

    port = port || defaultConfig.port;
    this.port = port;

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

    server = server ||this.getServer();
    this.server = server;

    app = app || express();
    this.app = app;

    wss = wss || new ws.Server({
      noServer: true,
    });
    this.wss = wss;

    staticSite = staticSite || false;
    this.staticSite = staticSite;

    const pather = new ArchaePather(dirname, installDirectory);
    this.pather = pather;
    const hasher = new ArchaeHasher(dirname, pather);
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

    this.mountApp();
  }

  loadCerts() {
    const {dirname, hostname, dataDirectory, cryptoDirectory} = this;

    const _getOldCerts = () => {
      const _getFile = fileName => {
        try {
          return fs.readFileSync(path.join(dirname, cryptoDirectory, fileName), 'utf8');
        } catch(err) {
          if (err.code !== 'ENOENT') {
            console.warn(err);
          }
          return null;
        }
      };

      const privateKey = _getFile('private.pem');
      const cert = _getFile('cert.pem');
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
      const keys = cryptoutils.generateKeys();
      const publicKey = keys.publicKey;
      const privateKey = keys.privateKey;
      const cert = cryptoutils.generateCert(keys, {
        commonName: hostname,
      });

      const cryptoDirectory = path.join(dirname, cryptoDirectory);
      const _makeCryptoDirectory = () => {
        mkdirp.sync(cryptoDirectory);
      };
      const _setFile = (fileName, fileData) => {
        fs.writeFileSync(path.join(cryptoDirectory, fileName), fileData);
      };

      _makeCryptoDirectory();
      _setFile('public.pem', publicKey);
      _setFile('private.pem', privateKey);
      _setFile('cert.pem', cert);

      return {
        privateKey,
        cert,
      };
    };

    return _getOldCerts() || _getNewCerts();
  }

  getServer() {
    const certs = this.loadCerts();

    return spdy.createServer({
      cert: certs.cert,
      key: certs.privateKey,
    });
  }

  requestPlugin(plugin) {
    return this.requestPlugins([plugin])
      .then(([plugin]) => Promise.resolve(plugin));
  }

  installPlugins(plugins) {
    return new Promise((accept, reject) => {
      const {pather, installer} = this;

      const cb = (err, result) => {
        if (!err) {
          accept(result);
        } else {
          reject(err);
        }
      };

      const _getModuleRealNames = plugins => Promise.all(plugins.map(plugin => new Promise((accept, reject) => {
        pather.getModuleRealName(plugin, (err, pluginName) => {
          if (!err) {
            accept(pluginName);
          } else {
            reject(err);
          }
        });
      })));
      const _lockPlugins = (mutex, pluginNames) => Promise.all(pluginNames.map(pluginName => mutex.lock(pluginName)))
        .then(unlocks => Promise.resolve(() => {
          for (let i = 0; i < unlocks.length; i++) {
            const unlock = unlocks[i];
            unlock();
          }
        }));
      const _bootPlugins = pluginNames => Promise.all(pluginNames.map(pluginName => new Promise((accept, reject) => {
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
                    this.mountPlugin(pluginName, err => {
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

      _getModuleRealNames(plugins)
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

      const _bootPlugins = pluginNames => Promise.all(pluginNames.map(pluginName => new Promise((accept, reject) => {
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
                    this.mountPlugin(pluginName, err => {
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

      this.installPlugins(plugins)
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

      pather.getModuleRealName(plugin, (err, pluginName) => {
        this.mountsMutex.lock(pluginName)
          .then(unlock => {
            this.unmountPlugin(pluginName, err => {
              if (!err) {
                this.unloadPlugin(pluginName);

                this.installsMutex.lock(pluginName)
                  .then(unlock => {
                    installer.removeModule(pluginName, err => {
                      if (!err) {
                        cb(null, {
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

            Promise.resolve(pluginInstance.mount())
              .then(pluginApi => {
                if (typeof pluginApi !== 'object' || pluginApi === null) {
                  pluginApi = {};
                }
                pluginApi[nameSymbol] = plugin;

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
        this.pluginInstances[plugin] = {};
        this.pluginApis[plugin] = {
          [nameSymbol]: plugin,
        };

        cb();
      }
    }
  }

  unmountPlugin(pluginName, cb) {
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

  getName(pluginApi) {
    return pluginApi ? pluginApi[nameSymbol] : null;
  }

  mountApp() {
    const {hostname, dirname, publicDirectory, installDirectory, metadata, server, app, wss, staticSite} = this;

    // user public
    if (publicDirectory) {
      app.use('/', express.static(path.join(dirname, publicDirectory)));
    }

    const upgradeHandlers = [];
    server.addUpgradeHandler = upgradeHandler => {
      upgradeHandlers.push(upgradeHandler);
    };
    server.removeUpgradeHandler = upgradeHandler => {
      upgradeHandlers.splice(upgradeHandlers.indexOf(upgradeHandler), 1);
    };
    server.on('upgrade', (req, socket, head) => {
      let handled = false;
      for (let i = 0; i < upgradeHandlers.length; i++) {
        const upgradeHandler = upgradeHandlers[i];
        if (upgradeHandler(req, socket, head) === false) {
          handled = true;
          break;
        }
      }

      if (!handled) {
        if (!staticSite) {
          wss.handleUpgrade(req, socket, head, c => {
            wss.emit('connection', c);
          });
        } else {
          socket.destroy();
        }
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
      app.get(/^\/archae\/plugins\/([^\/]+?)\/([^\/]+?)(-worker)?\.js$/, (req, res, next) => {
        const {params} = req;
        const module = params[0];
        const target = params[1];
        const worker = params[2];

        if (module === target) {
          const _respondOk = s => {
            res.type('application/javascript');
            res.send(s);
          };

          const key = module + (!worker ? '-client' : '-worker');
          const entry = bundleCache[key];
          if (entry !== undefined) {
            _respondOk(entry);
          } else {
            rollup.rollup({
              entry: path.join(dirname, installDirectory, 'plugins', 'node_modules',  module, (!worker ? 'client' : 'worker') + '.js'),
              plugins: [
                rollupPluginNodeResolve({
                  main: true,
                  preferBuiltins: false,
                }),
                rollupPluginCommonJs(),
                rollupPluginJson(),
              ],
            }).then(bundle => {
              const result = bundle.generate({
                moduleName: module,
                format: 'cjs',
                useStrict: false,
              });
              const {code} = result;
              const wrappedCode = '(function() {\n' + code + '\n})();\n';

              bundleCache[key] = wrappedCode;

              _respondOk(wrappedCode);
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

      wss.on('connection', c => {
        const {url} = c.upgradeReq;
        if (url === '/archae/ws') {
          console.log('connection open');

          this.connections.push(c);

          const e = {
            type: 'init',
            metadata,
          };
          const es = JSON.stringify(e);
          c.send(es);

          c.on('message', s => {
            const m = JSON.parse(s);

            const cb = err => {
              console.warn(err);
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
                  .then(pluginApis => Promise.all(pluginApis.map(pluginApi => new Promise((accept, reject) => {
                    const pluginName = this.getName(pluginApi);

                    this.getPluginClient(pluginName, (err, clientFileName) => {
                      if (!err) {
                        const hasClient = Boolean(clientFileName);

                        accept({
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
              } else if (method === 'releasePlugin') {
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
                const err = new Error('invalid message method: ' + JSON.stringify(method));
                cb(err);
              }
            } else {
              const err = new Error('invalid message');
              cb(err);
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
    const {host, port, server} = this;

    const listening = () => {
      cb();

      _cleanup();
    };
    const error = err => {
      cb(err);

      _cleanup();
    };

    const _cleanup = () => {
      server.removeListener('listening', listening);
      server.removeListener('error', error);
    };

    server.listen(port, host);
    server.on('listening', listening);
    server.on('error', error);
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
  constructor(dirname, pather) {
    this.dirname = dirname;
    this.pather = pather;

    this.moduleHashesMutex = new MultiMutex();
    this.modulesHashesJson = null;
    this.validatedModuleHashes = {};
  }

  loadModulesHashesJson(cb) {
    const {dirname, moduleHashesMutex, modulesHashesJson} = this;

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

          const modulesPath = path.join(dirname, 'data', 'modules');
          const moduleHashesJsonPath = path.join(modulesPath, 'hashes.json');

          fs.readFile(moduleHashesJsonPath, 'utf8', (err, s) => {
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
    const {dirname, moduleHashesMutex, modulesHashesJson} = this;

    this.loadModulesHashesJson((err, modulesHashesJson) => {
      if (!err) {
        moduleHashesMutex.lock(MODULE_HASHES_MUTEX_KEY)
          .then(unlock => {
            const unlockCb = (err, result) => {
              cb(err, result);

              unlock();
            };

            const modulesPath = path.join(dirname, 'data', 'modules');

            mkdirp(modulesPath, err => {
              if (!err) {
                const moduleHashesJsonPath = path.join(modulesPath, 'hashes.json');

                fs.writeFile(moduleHashesJsonPath, JSON.stringify(modulesHashesJson, null, 2), err => {
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
