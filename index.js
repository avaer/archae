const path = require('path');
const fs = require('fs-extra');
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
};

const npmCommands = (() => {
  const _hasCommand = command => child_process.spawnSync('bash', ['-c', 'type ' + command]).status === 0;

  if (_hasCommand('npm')) {
    return {
      add: ['npm', 'install'],
      install: ['npm', 'install'],
    };
  } else {
    return null;
  }
})();
if (!npmCommands) {
  throw new Error('no npm or yarn command available');
}

const nameSymbol = Symbol();

class ArchaeServer {
  constructor({dirname, hostname, host, port, publicDirectory, dataDirectory, server, app, wss, staticSite} = {}) {
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

    const pather = new ArchaePather(dirname);
    this.pather = pather;
    const hasher = new ArchaeHasher(dirname, pather);
    this.hasher = hasher;
    const installer = new ArchaeInstaller(dirname, pather, hasher);
    this.installer = installer;

    this.connections = [];

    this.plugins = {};
    this.pluginInstances = {};
    this.pluginApis = {};
    this.pluginsMutex = new MultiMutex();

    this.mountApp();
  }

  loadCerts() {
    const {dirname, hostname, dataDirectory} = this;

    const _getOldCerts = () => {
      const _getFile = fileName => {
        try {
          return fs.readFileSync(path.join(dirname, dataDirectory, 'crypto', fileName), 'utf8');
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

      const cryptoDirectory = path.join(dirname, dataDirectory, 'crypto');
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

  requestPlugin(plugin, opts = {}) {
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
        if (!err) {
          const {pluginsMutex} = this;

          pluginsMutex.lock(pluginName)
            .then(unlock => {
              const unlockCb = (cb => (err, result) => {
                cb(err, result);

                unlock();
              })(cb);
          
              const _remove = cb => {
                installer.removeModule(pluginName, cb);
              };
              const _add = cb => {
                installer.addModule(plugin, err => {
                  if (!err) {
                    const existingPlugin = this.plugins[pluginName];
                    if (existingPlugin !== undefined) {
                      const pluginApi = this.pluginApis[pluginName];
                      cb(null, pluginApi);
                    } else {
                      this.loadPlugin(pluginName, err => {
                        if (!err) {
                          this.mountPlugin(pluginName, err => {
                            if (!err) {
                              const pluginApi = this.pluginApis[pluginName];
                              cb(null, pluginApi);
                            } else {
                              cb(err);
                            }
                          });
                        } else {
                          cb(err);
                        }
                      });
                    }
                  } else {
                    cb(err);
                  }
                });
              };

              if (opts.force) {
                _remove(err => {
                  if (!err) {
                    _add(unlockCb);
                  } else {
                    unlockCb(err);
                  }
                });
              } else {
                _add(unlockCb);
              }
            })
            .catch(cb);
        } else {
          cb(err);
        }
      });
    });
  }

  requestPlugins(plugins, opts = {}) {
    const requestPluginPromises = plugins.map(plugin => this.requestPlugin(plugin, opts));
    return Promise.all(requestPluginPromises);
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
        this.pluginsMutex.lock(pluginName)
          .then(unlock => {
            const unlockCb = (cb => (err, result) => {
              cb(err, result);

              unlock();
            })(cb);

            this.unmountPlugin(pluginName, err => {
              if (!err) {
                this.unloadPlugin(pluginName);

                installer.removeModule(pluginName, err => {
                  if (!err) {
                    unlockCb(null, {
                      pluginName,
                    });
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
      });
    });
  }

  releasePlugins(plugins, opts = {}) {
    const releasePluginPromises = plugins.map(plugin => this.releasePlugin(plugin, opts));
    return Promise.all(releasePluginPromises);
  }

  getPackageJsonFileName(plugin, packageJsonFileNameKey, cb) {
    const {dirname} = this;

    fs.readFile(path.join(dirname, 'installed', 'plugins', 'node_modules', plugin, 'package.json'), 'utf8', (err, s) => {
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
    this.getPackageJsonFileName(plugin, 'server', (err, fileName) => {
      if (!err) {
        if (fileName) {
          const {dirname} = this;
          const moduleRequire = require(path.join(dirname, 'installed', 'plugins', 'node_modules', plugin, fileName));

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

  unloadPlugin(pluginName) {
    delete this.plugins[pluginName];
  }

  mountPlugin(plugin, cb) {
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
      process.nextTick(cb);
    }
  }

  getCore() {
    return {
      express: express,
      server: this.server,
      app: this.app,
      wss: this.wss,
      dirname: this.dirname,
    };
  }

  getName(pluginApi) {
    return pluginApi ? pluginApi[nameSymbol] : null;
  }

  mountApp() {
    const {dirname, publicDirectory, server, app, wss, staticSite} = this;

    // user public
    if (publicDirectory) {
      app.use('/', express.static(path.join(dirname, publicDirectory)));
    }

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
              entry: path.join(dirname, 'installed', 'plugins', 'node_modules',  module, (!worker ? 'client' : 'worker') + '.js'),
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
          wss.handleUpgrade(req, socket, head, c => {
            wss.emit('connection', c);
          });
        }
      });

      wss.on('connection', c => {
        const {url} = c.upgradeReq;
        if (url === '/archae/ws') {
          console.log('connection open');

          this.connections.push(c);

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
              } else if (method === 'releasePlugin') {
                const {plugin} = args;

                this.releasePlugin(plugin)
                  .then(result => {
                    const {pluginName} = result;

                    cb(null, {
                      pluginName,
                    });
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
  constructor(dirname) {
    this.dirname = dirname;
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
    const {dirname} = this;
    return path.join(dirname, 'installed', 'plugins', 'node_modules', moduleName);
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

              cb(null, {exists, outdated, moduleName, installedHash, candidateHash});
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
  constructor(dirname, pather, hasher) {
    this.dirname = dirname;
    this.pather = pather;
    this.hasher = hasher;

    this.running = false;
    this.queue = [];
  }

  addModule(module, cb) {
    const {dirname, pather} = this;

    const _installModule = (module, cb) => {
      if (path.isAbsolute(module)) {
        const modulePackageJsonPath = pather.getLocalModulePackageJsonPath(module);

        fs.readFile(modulePackageJsonPath, 'utf8', (err, s) => {
          if (!err) {
            const j = JSON.parse(s);
            const moduleName = j.name;
            const modulePath = pather.getInstalledModulePath(moduleName);

            fs.exists(modulePath, exists => {
              if (exists) {
                _npmInstall(moduleName, err => {
                  if (!err) {
                    cb();
                  } else {
                    cb(err);
                  }
                });
              } else {
                const localModulePath = path.join(dirname, module);
                fs.copy(localModulePath, modulePath, err => {
                  if (!err) {
                    _npmInstall(moduleName, err => {
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
              }
            });
          } else {
            cb(err);

            cleanup();
          }
        });  
      } else {
        const moduleName = module;

        _npmAdd(moduleName, err => {
          if (!err) {
            const modulePackageJsonPath = pather.getInstalledModulePackageJsonPath(moduleName);

            fs.readFile(modulePackageJsonPath, 'utf8', (err, s) => {
              if (!err) {
                const j = JSON.parse(s);
                cb(null, j);
              } else {
                cb(err);
              }
            });
          } else {
            cb(err);
          }
        });
      }
    };
    const _npmAdd = (module, cb) => {
      this.queueNpm(cleanup => {
        const npmAdd = child_process.spawn(
          npmCommands.add[0],
          npmCommands.add.slice(1).concat([ module ]),
          {
            cwd: path.join(dirname, 'installed', 'plugins'),
          }
        );
        npmAdd.stdout.pipe(process.stdout);
        npmAdd.stderr.pipe(process.stderr);
        npmAdd.on('exit', code => {
          if (code === 0) {
            cb();
          } else {
            const err = new Error('npm add error: ' + code);
            cb(err);
          }

          cleanup();
        });
      });
    };
    const _npmInstall = (moduleName, cb) => {
      this.queueNpm(cleanup => {
        const modulePath = pather.getInstalledModulePath(moduleName);

        const npmInstall = child_process.spawn(
          npmCommands.install[0],
          npmCommands.install.slice(1),
          {
            cwd: modulePath,
          }
        );
        npmInstall.stdout.pipe(process.stdout);
        npmInstall.stderr.pipe(process.stderr);
        npmInstall.on('exit', code => {
          if (code === 0) {
            cb();
          } else {
            const err = new Error('npm install error: ' + code);
            cb(err);
          }

          cleanup();
        });
      });
    };

    mkdirp(path.join(dirname, 'installed', 'plugins'), err => {
      if (!err) {
        const {hasher} = this;

        hasher.getModuleInstallStatus(module, (err, result) => {
          if (!err) {
            const {exists, outdated, moduleName, installedHash, candidateHash} = result;

            const _doAdd = cb => {
              _installModule(module, cb);
            };
            const _doRemove = cb => {
              this.removeModule(moduleName, cb);
            };
            const _doUpdateHash = cb => {
              hasher.setModuleHash(moduleName, candidateHash, cb);
            };
            const _doValidateHash = () => {
              hasher.setValidatedModuleHash(moduleName, candidateHash);
            };

            if (!exists) {
              _doAdd(err => {
                if (!err) {
                  _doUpdateHash(err => {
                    if (!err) {
                      _doValidateHash();

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
              if (outdated) {
                _doRemove(err => {
                  if (!err) {
                    _doAdd(err => {
                      if (!err) {
                        _doUpdateHash(err => {
                          if (!err) {
                            _doValidateHash();

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
                    cb(err);
                  }
                });
              } else {
                _doValidateHash();

                cb();
              }
            }
          } else {
            cb(err);
          }
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
