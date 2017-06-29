const fs = require("fs-extra-promise");
const path = require('path');
const modulesDirectory = path.resolve(`${__dirname.replace(/\/\w+$/, ``)}/modules/`);
const express = require("express");

// Heavily inspired by EricRabil's work on DDBot.

class ModuleManager {
    constructor(app) {
        this.app = app;
        this.modules = new Map();
        this.moduleMetas = {};
        this.modulePaths = {};
        this.moduleIdentifiers = [];
        this.viewExtensions = {};

        this.loadingCallbacks = [];
        this.loaded = false;
    }

    load(meta, mainPath) {
        var s = this;
        var validDependencies = true;
        var withoutConflicts = true;
        // Check dependency modules
        meta.depends.every((dependency) => {
            if(!this.moduleIdentifiers.includes(directory)) {
                validDependencies = false;
                return false;
            }
            return true;
        });
        if(!validDependencies) return console.error(`Couldn't load module "${meta.name}" (${meta.identifier}) because it depends on a module with the identifier "${meta.identifier}."`);
        // Check conflicting modules
        meta.conflicts.every((conflict) => {
            if(this.moduleIdentifiers.includes(directory)) {
                withoutConflicts = false;
                return false;
            }
            return true;
        })
        if(!withoutConflicts) return console.error(`Couldn't load module "${meta.name}" (${meta.identifier}) because it conflicts with a module with the identifier "${meta.identifier}".`);
        // Make sure there isn't already one loaded
        if(this.modules.has(meta.identifier)) return console.error(`Couldn't load module "${meta.name}" (${meta.identifier}) because another module with the same identifier was already loaded.`);
        // Initialize the module
        s.moduleMetas[meta.identifier] = meta;
        s.modulePaths[meta.identifier] = path.dirname(mainPath);
        function finalizeLoad() {
            var Module = require(mainPath);
            var newModule = new Module(s.app);
            s.modules.set(meta.identifier, newModule);
            console.log(`Loaded module "${meta.name}" (${meta.identifier}).`);
            console.log(s.viewExtensions);
        }
        this.processViewExtensionsForModule(meta, () => finalizeLoad());
    }

    loadAll() {
        console.log("Starting load of modules...");
        fs.readdir(modulesDirectory, (err, files) => {
            if(err) return this.app.reportError("Error loading modules: " + err);
            if(files.length <= 0) return console.log("No modules loaded.");
            // Try and load information about all the modules
            var promises = files.map((file) => this.processModuleLoadingInformation(file));
            Promise.all(promises).then(moduleInfo => {
                // Remove nulls and sort by priority
                moduleInfo = moduleInfo.filter((o) => !!o).sort((a, b) => b.priority - a.priority); 
                this.moduleIdentifiers = moduleInfo.map((info) => info.identifier);
                moduleInfo.forEach((info) => this.load(info.meta, info.main));
                this.loaded = true;
                this.loadingCallbacks.forEach((callback) => callback(this));
            }).catch(err => this.app.reportError("Error loading modules: " + err));
        });
    }

    fireWhenLoaded(callback) {
        if(this.loaded) return callback(this);
        this.loadingCallbacks.push(callback);
    }

    processModuleLoadingInformation(file) {
        return new Promise((resolve, reject) => {
            var folderPath = path.join(modulesDirectory, file);
            fs.stat(folderPath, (err, stat) => {
                if(err) {
                    this.app.reportError("Error loading single module directory: " + err);
                    return resolve(null);
                }
                if(!stat.isDirectory()) return;
                var folder = path.parse(folderPath);
                var nicePath = path.join(folder.dir, folder.base);
                // Attempt to stat module.json
                fs.stat(path.join(nicePath, "module.json"), (err) => {
                    if(err) {
                        console.error(`Skipping malformed module "${folder.name}" (error loading module.json).`);
                        return resolve(null);
                    }
                    var moduleMeta = require(path.join(nicePath, "module.json"));
                    if(!moduleMeta.main || !moduleMeta.identifier || !moduleMeta.name) return console.error(`Skipping malformed module "${folder.name}" (invalid module.json).`);
                    moduleMeta = this.addMetaDefaults(moduleMeta);
                    // Attempt to stat main module JS file
                    fs.stat(path.join(nicePath, moduleMeta.main), (err) => {
                        if(err) {
                            console.error(`Skipping malformed module "${folder.name}" (error loading main file).`);
                            return resolve(null);
                        }
                        // Success, load it
                        resolve({meta: moduleMeta, main: path.join(nicePath, moduleMeta.main)});
                    });
                });
            });
        });
    }

    addMetaDefaults(meta) {
        if(!meta.priority) meta.priority = 1;
        if(!meta.routes) meta.routes = [];
        if(!meta.depends) meta.depends = [];
        if(!meta.conflicts) meta.conflicts = [];
        if(!meta.publicRoot) meta.publicRoot = "/";
        return meta;
    }

    // --- Resource Loading ---

    getResourcesFromModules(req) {
        var resources = { css: [], js: [] };
        this.modules.forEach((module) => {
            if(typeof module.getCSSResourceList === "function") resources.css = resources.css.concat(module.getCSSResourceList(req));
            if(typeof module.getJSResourceList === "function") resources.js = resources.js.concat(module.getJSResourceList(req));
        });
        return resources;
    }

    // --- Static File Serving ---

    getAllPublicDirectoriesToRegister() {
        return new Promise((resolve, reject) => {
            var promises = Object.keys(this.moduleMetas).map((module) => this.getRegisteredPublicDirectoriesForModule(this.moduleMetas[module]));
            Promise.all(promises).then((directories) => resolve(directories.filter((o) => !!o))).catch((err) => {
                this.app.reportError("Error loading public directories for modules: " + err);
                resolve();
            });
        });
    }

    getRegisteredPublicDirectoriesForModule(meta) {
        return new Promise((resolve, reject) => {
            var publicPath = path.join(this.modulePaths[meta.identifier], "public");
            fs.stat(publicPath, (err, stat) => {
                if(err || !stat.isDirectory()) return resolve(null);
                resolve({root: meta.publicRoot, middleware: express.static(publicPath)});
            });
        });
    }

    // --- Registering More Routes ---

    getRoutesToRegister() {
        return new Promise((resolve, reject) => {
            var promises = Object.keys(this.moduleMetas).map((module) => this.getRoutesToRegisterForModule(this.moduleMetas[module]));
            Promise.all(promises).then((routes) => resolve(routes.filter((o) => !!o))).catch((err) => {
                this.app.reportError("Error loading routes for modules: " + err);
                resolve();
            });
        });
    }

    getRoutesToRegisterForModule(meta) {
        return new Promise((resolve, reject) => {
            var promises = meta.routes.filter((info) => info.path && info.file).map((info) => this.getRouterForRouterInformationAndMeta(info, meta));
            Promise.all(promises).then((routes) => resolve(routes)).catch((err) => {
                this.app.reportError(`Error loading routes for module "${meta.name}" (${meta.identifier}): ${err}`);
                resolve();
            });
        });
    }

    getRouterForRouterInformationAndMeta(routerInfo, meta) {
        return new Promise((resolve, reject) => {
            var routerPath = path.join(path.join(this.modulePaths[meta.identifier], "routes"), routerInfo.file);
            fs.stat(routerPath, (err, stat) => {
                if(err || stat.isDirectory()) return resolve(null);
                var Router = require(routerPath);
                resolve({root: routerInfo.path, middleware: Router(this.app)});
            });
        });
    }

    // --- Middleware ---

    processRequest(req, res, next) {
        var middlewareFetchers = Array.from(this.modules.values()).filter((module) => typeof module.processRequest === "function").map((module) => module.processRequest);
        var middlewares = [];
        middlewareFetchers.forEach((process) => middlewares = middlewares.concat(process(req)));
        var index = 0;
        function handleNext() {
            if(!middlewares[index]) return next();
            index++;
            middlewares[index - 1](req, res, () => handleNext());
        }
        handleNext();
    }

    // --- View Extensions ---

    processViewExtensionsForModule(meta, callback) {
        var vPath = path.join(this.modulePaths[meta.identifier], "views");
        fs.stat(vPath, (err, stat) => {
            if(err || !stat.isDirectory()) return callback();
            fs.readdir(vPath, (err, files) => {
                files.filter((fn) => path.extname(fn) == ".html").forEach((file) => {
                    var templateName = file.toLowerCase().slice(0, -5);
                    if(!this.viewExtensions[templateName]) this.viewExtensions[templateName] = [];
                    this.viewExtensions[templateName].push(path.join(vPath, file));
                });
                callback();
            });
        });
    }

    getViewExtensions(name) {
        return this.viewExtensions[name] || [];
    }

    gatherViewExtensions(name, include) {
        return this.getViewExtensions(name).map((file) => include(file)).join("");
    }
}

ModuleManager.prototype = Object.create(ModuleManager.prototype);

module.exports = ModuleManager;