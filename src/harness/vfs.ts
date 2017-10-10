/// <reference path="./harness.ts" />
/// <reference path="./collections.ts" />
/// <reference path="./vpath.ts" />
/// <reference path="../compiler/commandLineParser.ts"/>
namespace Utils {
    import compareStrings = Collections.compareStrings;
    import removeAt = ts.orderedRemoveItemAt;
    import KeyedCollection = Collections.KeyedCollection;
    import Metadata = Collections.Metadata;

    // import IO = Harness.IO;

    // export interface PathMappings {
    //     [path: string]: string;
    // }

    // export interface FileSystemResolver {
    //     getEntries(dir: VirtualDirectory): { files: string[], directories: string[] };
    //     getContent(file: VirtualFile): string | undefined;
    // }

    // function createMapper(ignoreCase: boolean, map: PathMappings | undefined) {
    //     if (!map) return identity;
    //     const roots = Object.keys(map);
    //     const patterns = roots.map(root => createPattern(root, ignoreCase));
    //     return function (path: string) {
    //         for (let i = 0; i < patterns.length; i++) {
    //             const match = patterns[i].exec(path);
    //             if (match) {
    //                 const prefix = path.slice(0, match.index);
    //                 const suffix = path.slice(match.index + match[0].length);
    //                 return vpath.combine(prefix, map[roots[i]], suffix);
    //             }
    //         }
    //         return path;
    //     };
    // }

    // function createPattern(path: string, ignoreCase: boolean) {
    //     path = vpath.normalizeSlashes(path);
    //     const components = vpath.parse(path);
    //     let pattern = "";
    //     for (let i = 1; i < components.length; i++) {
    //         const component = components[i];
    //         if (pattern) pattern += "/";
    //         pattern += escapeRegExp(component);
    //     }
    //     pattern = (components[0] ? "^" + escapeRegExp(components[0]) : "/") + pattern + "(/|$)";
    //     return new RegExp(pattern, ignoreCase ? "i" : "");
    // }

    // export function createResolver(io: IO, map?: PathMappings): FileSystemResolver {
    //     const mapper = createMapper(!io.useCaseSensitiveFileNames(), map);
    //     return {
    //         getEntries(dir) {
    //             return io.getAccessibleFileSystemEntries(mapper(dir.path));
    //         },
    //         getContent(file) {
    //             return io.readFile(mapper(file.path));
    //         }
    //     };
    // }

    export type FindAxis = "ancestors" | "ancestors-or-self" | "self" | "descendents-or-self" | "descendents";

    export abstract class VirtualFileSystemEntry {
        private _readonly = false;
        private _path: string;
        private _metadata: Metadata;

        /**
         * Gets the name of this entry.
         */
        public readonly name: string;

        constructor(name: string) {
            this.name = name;
        }

        /**
         * Gets the file system to which this entry belongs.
         */
        public get fileSystem(): VirtualFileSystem {
            return this.parent.fileSystem;
        }

        /**
         * Gets the container for this entry.
         */
        public abstract get parent(): VirtualFileSystemContainer;

        /**
         * Gets the entry that this entry shadows.
         */
        public abstract get shadowRoot(): VirtualFileSystemEntry | undefined;

        /**
         * Gets metadata about this entry.
         */
        public get metadata(): Metadata {
            return this._metadata || (this._metadata = new Metadata(this.shadowRoot ? this.shadowRoot.metadata : undefined));
        }

        /**
         * Gets a value indicating whether this entry is read-only.
         */
        public get isReadOnly(): boolean {
            return this._readonly;
        }

        public get path(): string {
            return this._path || (this._path = vpath.combine(this.parent.path, this.name));
        }

        public get relative(): string {
            return this.relativeTo(this.fileSystem.currentDirectory);
        }

        public get exists(): boolean {
            return this.parent.exists
                && this.parent.getEntry(this.name) as VirtualFileSystemEntry === this;
        }

        public makeReadOnly(): void {
            this.makeReadOnlyCore();
            this._readonly = true;
        }

        public relativeTo(other: string | VirtualFileSystemEntry) {
            if (other) {
                const otherPath = typeof other === "string" ? other : other.path;
                const ignoreCase = !this.fileSystem.useCaseSensitiveFileNames;
                return vpath.relative(otherPath, this.path, ignoreCase);
            }
            return this.path;
        }

        /**
         * Creates a file system entry that shadows this file system entry.
         * @param parent The container for the shadowed entry.
         */
        public abstract shadow(parent: VirtualFileSystemContainer): VirtualFileSystemEntry;

        protected abstract makeReadOnlyCore(): void;

        protected writePreamble(): void {
            if (this._readonly) throw new Error("Cannot modify a frozen entry.");
        }

        protected shadowPreamble(parent: VirtualFileSystemContainer): void {
            if (this.parent !== parent.shadowRoot) throw new Error("Incorrect shadow parent");
            let fileSystem: VirtualFileSystem | undefined = this.fileSystem;
            while (fileSystem) {
                if (parent.fileSystem === fileSystem) throw new Error("Cannot create shadow for parent in the same file system.");
                fileSystem = fileSystem.shadowRoot;
            }
        }
    }

    export abstract class VirtualFileSystemContainer extends VirtualFileSystemEntry {
        private _childAddedCallbacks: ((entry: VirtualFile | VirtualDirectory) => void)[];
        private _childRemovedCallbacks: ((entry: VirtualFile | VirtualDirectory) => void)[];

        public abstract get shadowRoot(): VirtualFileSystemContainer | undefined;

        public addOnChildAdded(callback: (entry: VirtualFile | VirtualDirectory) => void) {
            if (!this._childAddedCallbacks) {
                this._childAddedCallbacks = [callback];
            }
            else if (this._childAddedCallbacks.indexOf(callback) === -1) {
                this._childAddedCallbacks.push(callback);
            }
        }

        public removeOnChildAdded(callback: (entry: VirtualFile | VirtualDirectory) => void) {
            if (this._childAddedCallbacks) {
                const index = this._childAddedCallbacks.indexOf(callback);
                if (index >= 0) removeAt(this._childAddedCallbacks, index);
            }
        }

        public addOnChildRemoved(callback: (entry: VirtualFile | VirtualDirectory) => void) {
            if (!this._childRemovedCallbacks) {
                this._childRemovedCallbacks = [callback];
            }
            else if (this._childRemovedCallbacks.indexOf(callback) === -1) {
                this._childRemovedCallbacks.push(callback);
            }
        }

        public removeOnChildRemoved(callback: (entry: VirtualFile | VirtualDirectory) => void) {
            if (this._childRemovedCallbacks) {
                const index = this._childRemovedCallbacks.indexOf(callback);
                if (index >= 0) removeAt(this._childRemovedCallbacks, index);
            }
        }

        public getEntries(options: { recursive?: boolean, pattern?: RegExp, kind: "file" }): VirtualFile[];
        public getEntries(options: { recursive?: boolean, pattern?: RegExp, kind: "directory" }): VirtualDirectory[];
        public getEntries(options?: { recursive?: boolean, pattern?: RegExp, kind?: "file" | "directory" }): (VirtualFile | VirtualDirectory)[];
        public getEntries(options: { recursive?: boolean, pattern?: RegExp, kind?: "file" | "directory" } = {}): (VirtualFile | VirtualDirectory)[] {
            const results: (VirtualFile | VirtualDirectory)[] = [];
            if (options.recursive) {
                this.getOwnEntries().forEach(entry => {
                    if (entry instanceof VirtualFile) {
                        if (isMatch(entry, options)) {
                            results.push(entry);
                        }
                    }
                    else if (entry instanceof VirtualDirectory) {
                        if (isMatch(entry, options)) {
                            results.push(entry);
                        }
                        for (const child of entry.getEntries(options)) {
                            results.push(child);
                        }
                    }
                });
            }
            else {
                this.getOwnEntries().forEach(entry => {
                    if (isMatch(entry, options)) {
                        results.push(entry);
                    }
                });
            }
            return results;
        }

        public getDirectories(options: { recursive?: boolean, pattern?: RegExp } = {}): VirtualDirectory[] {
            return this.getEntries({ ...options, kind: "directory" });
        }

        public getFiles(options: { recursive?: boolean, pattern?: RegExp } = {}): VirtualFile[] {
            return this.getEntries({ ...options, kind: "file" });
        }

        public getEntryNames(options: { recursive?: boolean, qualified?: boolean, pattern?: RegExp, kind?: "file" | "directory" } = {}): string[] {
            return this.getEntries(options).map(entry =>
                options && options.qualified ? entry.path :
                options && options.recursive ? entry.relativeTo(this) :
                entry.name);
        }

        public getDirectoryNames(options: { recursive?: boolean, qualified?: boolean, pattern?: RegExp } = {}): string[] {
            return this.getEntryNames({ ...options, kind: "directory" });
        }

        public getFileNames(options: { recursive?: boolean, qualified?: boolean, pattern?: RegExp } = {}): string[] {
            return this.getEntryNames({ ...options, kind: "file" });
        }

        public abstract getEntry(path: string, options: { followSymlinks?: boolean, pattern?: RegExp, kind: "file" }): VirtualFile | undefined;
        public abstract getEntry(path: string, options: { followSymlinks?: boolean, pattern?: RegExp, kind: "directory" }): VirtualDirectory | undefined;
        public abstract getEntry(path: string, options?: { followSymlinks?: boolean, pattern?: RegExp, kind?: "file" | "directory" }): VirtualFile | VirtualDirectory | undefined;

        public getDirectory(path: string, options: { followSymlinks?: boolean, pattern?: RegExp } = {}): VirtualDirectory | undefined {
            return this.getEntry(path, { ...options, kind: "directory" });
        }

        public getFile(path: string, options: { followSymlinks?: boolean, pattern?: RegExp } = {}): VirtualFile | undefined {
            return this.getEntry(path, { ...options, kind: "file" });
        }

        public findEntry(path: string, axis: FindAxis, options: { followSymlinks?: boolean, pattern?: RegExp, kind: "file" }): VirtualFile | undefined;
        public findEntry(path: string, axis: FindAxis, options: { followSymlinks?: boolean, pattern?: RegExp, kind: "directory" }): VirtualDirectory | undefined;
        public findEntry(path: string, axis: FindAxis, options?: { followSymlinks?: boolean, pattern?: RegExp, kind?: "file" | "directory" }): VirtualFile | VirtualDirectory | undefined;
        public findEntry(path: string, axis: FindAxis, options: { followSymlinks?: boolean, pattern?: RegExp, kind?: "file" | "directory" } = {}): VirtualFile | VirtualDirectory | undefined {
            const walkAncestors = axis === "ancestors-or-self" || axis === "ancestors";
            const walkDescendents = axis === "descendents-or-self" || axis === "descendents";
            const walkSelf = axis === "ancestors-or-self" || axis === "self" || axis === "descendents-or-self";
            if (walkSelf) {
                const entry = this.getEntry(path, options);
                if (entry) return entry;
            }
            if (walkAncestors) {
                const entry = !(this instanceof VirtualFileSystem) && this.parent.findEntry(path, "ancestors-or-self", options);
                if (entry) return entry;
            }
            if (walkDescendents) {
                for (const child of this.getDirectories()) {
                    const entry = child.findEntry(path, "descendents-or-self", options);
                    if (entry) return entry;
                }
            }
        }

        public findDirectory(path: string, axis: FindAxis, options: { followSymlinks?: boolean, pattern?: RegExp } = {}): VirtualDirectory | undefined {
            return this.findEntry(path, axis, { ...options, kind: "directory" });
        }

        public findFile(path: string, axis: FindAxis, options: { followSymlinks?: boolean, pattern?: RegExp } = {}): VirtualFile | undefined {
            return this.findEntry(path, axis, { ...options, kind: "file" });
        }

        protected abstract getOwnEntries(): KeyedCollection<string, VirtualFile | VirtualDirectory>;

        protected raiseOnChildAdded(entry: VirtualFile | VirtualDirectory) {
            if (this._childAddedCallbacks) {
                for (const callback of this._childAddedCallbacks) {
                    callback(entry);
                }
            }
        }

        protected raiseOnChildRemoved(entry: VirtualFile | VirtualDirectory) {
            if (this._childRemovedCallbacks) {
                for (const callback of this._childRemovedCallbacks) {
                    callback(entry);
                }
            }
        }
    }

    export class VirtualFileSystem extends VirtualFileSystemContainer {
        // private static _builtLocal: VirtualFileSystem | undefined;
        // private static _builtLocalCI: VirtualFileSystem | undefined;
        // private static _builtLocalCS: VirtualFileSystem | undefined;

        private _root: VirtualDirectory;
        private _useCaseSensitiveFileNames: boolean;
        private _currentDirectory: string;
        private _currentDirectoryStack: string[] | undefined;
        private _shadowRoot: VirtualFileSystem | undefined;

        constructor(currentDirectory: string, useCaseSensitiveFileNames: boolean) {
            super("");
            this._currentDirectory = currentDirectory.replace(/\\/g, "/");
            this._useCaseSensitiveFileNames = useCaseSensitiveFileNames;
        }

        public get fileSystem(): VirtualFileSystem {
            return this;
        }

        public get parent(): VirtualFileSystemContainer {
            return this;
        }

        public get shadowRoot(): VirtualFileSystem | undefined {
            return this._shadowRoot;
        }

        public get useCaseSensitiveFileNames() {
            return this._useCaseSensitiveFileNames;
        }

        public get currentDirectory() {
            return this._currentDirectory;
        }

        public get path() {
            return "";
        }

        public get relative() {
            return "";
        }

        public get exists() {
            return true;
        }

        public get root() {
            if (this._root === undefined) {
                if (this._shadowRoot) {
                    this._root = this._shadowRoot.root.shadow(this);
                }
                else {
                    this._root = new VirtualDirectory(this, "");
                }
                if (this.isReadOnly) this._root.makeReadOnly();
            }
            return this._root;
        }

        // public static getBuiltLocal(useCaseSensitiveFileNames: boolean = io.useCaseSensitiveFileNames()): VirtualFileSystem {
        //     let vfs = useCaseSensitiveFileNames ? this._builtLocalCS : this._builtLocalCI;
        //     if (!vfs) {
        //         vfs = this._builtLocal;
        //         if (!vfs) {
        //             const resolver = createResolver(io, {
        //                 "/.ts": getBuiltDirectory(),
        //                 "/.lib": getLibFilesDirectory()
        //             });
        //             vfs = new VirtualFileSystem("/", io.useCaseSensitiveFileNames());
        //             vfs.addDirectory("/.ts", resolver);
        //             vfs.addDirectory("/.lib", resolver);
        //             vfs.addDirectory("/.test");
        //             vfs.changeDirectory("/.test");
        //             vfs.makeReadOnly();
        //             this._builtLocal = vfs;
        //         }
        //         if (vfs._useCaseSensitiveFileNames !== useCaseSensitiveFileNames) {
        //             vfs = vfs.shadow();
        //             vfs._useCaseSensitiveFileNames = useCaseSensitiveFileNames;
        //             vfs.makeReadOnly();
        //         }
        //         return useCaseSensitiveFileNames
        //             ? this._builtLocalCS = vfs
        //             : this._builtLocalCI = vfs;
        //     }
        //     return vfs;
        // }

        // public static createFromOptions(options: { useCaseSensitiveFileNames?: boolean, currentDirectory?: string }) {
        //     const vfs = this.getBuiltLocal(options.useCaseSensitiveFileNames).shadow();
        //     if (options.currentDirectory) {
        //         vfs.addDirectory(options.currentDirectory);
        //         vfs.changeDirectory(options.currentDirectory);
        //     }
        //     return vfs;
        // }

        // public static createFromDocuments(options: { useCaseSensitiveFileNames?: boolean, currentDirectory?: string }, documents: TextDocument[], fileOptions?: { overwrite?: boolean }) {
        //     const vfs = this.createFromOptions(options);
        //     for (const document of documents) {
        //         const file = vfs.addFile(document.file, document.text, fileOptions)!;
        //         assert.isDefined(file, `Failed to add file: '${document.file}'`);
        //         file.metadata.set("document", document);
        //         // Add symlinks
        //         const symlink = document.meta.get("symlink");
        //         if (file && symlink) {
        //             for (const link of symlink.split(",")) {
        //                 const symlink = vfs.addSymlink(vpath.resolve(vfs.currentDirectory, link.trim()), file)!;
        //                 assert.isDefined(symlink, `Failed to symlink: '${link}'`);
        //                 symlink.metadata.set("document", document);
        //             }
        //         }
        //     }
        //     return vfs;
        // }

        public changeDirectory(path: string) {
            this.writePreamble();
            if (path) {
                this._currentDirectory = vpath.resolve(this._currentDirectory, path);
            }
        }

        public pushDirectory(path = this.currentDirectory) {
            this.writePreamble();
            if (this._currentDirectoryStack === undefined) {
                this._currentDirectoryStack = [this.currentDirectory];
            }
            else {
                this._currentDirectoryStack.push(this.currentDirectory);
            }
            this.changeDirectory(path);
        }

        public popDirectory() {
            this.writePreamble();
            const previousDirectory = this._currentDirectoryStack && this._currentDirectoryStack.pop();
            if (previousDirectory !== undefined) {
                this._currentDirectory = previousDirectory;
            }
        }

        public addDirectory(path: string /*, resolver?: FileSystemResolver */) {
            return this.root.addDirectory(vpath.resolve(this.currentDirectory, path) /*, resolver */);
        }

        public addFile(path: string, content?: /*FileSystemResolver["getContent"] |*/ string, options?: { overwrite?: boolean }) {
            return this.root.addFile(vpath.resolve(this.currentDirectory, path), content, options);
        }

        public addSymlink(path: string, target: VirtualFile): VirtualFileSymlink | undefined;
        public addSymlink(path: string, target: VirtualDirectory): VirtualDirectorySymlink | undefined;
        public addSymlink(path: string, target: string | VirtualFile | VirtualDirectory): VirtualSymlink | undefined;
        public addSymlink(path: string, target: string | VirtualFile | VirtualDirectory) {
            if (typeof target === "string") target = vpath.resolve(this.currentDirectory, target);
            return this.root.addSymlink(vpath.resolve(this.currentDirectory, path), target);
        }

        public removeDirectory(path: string): boolean {
            return this.root.removeDirectory(vpath.resolve(this.currentDirectory, path));
        }

        public removeFile(path: string): boolean {
            return this.root.removeFile(vpath.resolve(this.currentDirectory, path));
        }

        public readFile(path: string): string | undefined {
            const file = this.getFile(vpath.resolve(this.currentDirectory, path));
            return file && file.getContent();
        }

        public writeFile(path: string, content: string): void {
            path = vpath.resolve(this.currentDirectory, path);
            const file = this.getFile(path) || this.addFile(path);
            if (file) {
                file.setContent(content);
            }
        }

        public directoryExists(path: string) {
            return this.getEntry(path) instanceof VirtualDirectory;
        }

        public fileExists(path: string) {
            return this.getEntry(path) instanceof VirtualFile;
        }

        public sameName(a: string, b: string) {
            return compareStrings(a, b, !this.useCaseSensitiveFileNames) === 0;
        }

        public getRealEntry(entry: VirtualDirectory): VirtualDirectory | undefined;
        public getRealEntry(entry: VirtualFile): VirtualFile | undefined;
        public getRealEntry(entry: VirtualFile | VirtualDirectory): VirtualFile | VirtualDirectory | undefined;
        public getRealEntry(entry: VirtualFile | VirtualDirectory): VirtualFile | VirtualDirectory | undefined {
            if (entry instanceof VirtualFileSymlink || entry instanceof VirtualDirectorySymlink) {
                return findTarget(this, entry.target);
            }
            return entry;
        }

        public getEntry(path: string, options: { followSymlinks?: boolean, pattern?: RegExp, kind: "file" }): VirtualFile | undefined;
        public getEntry(path: string, options: { followSymlinks?: boolean, pattern?: RegExp, kind: "directory" }): VirtualDirectory | undefined;
        public getEntry(path: string, options?: { followSymlinks?: boolean, pattern?: RegExp, kind?: "file" | "directory" }): VirtualFile | VirtualDirectory | undefined;
        public getEntry(path: string, options?: { followSymlinks?: boolean, pattern?: RegExp, kind?: "file" | "directory" }) {
            return this.root.getEntry(vpath.resolve(this.currentDirectory, path), options);
        }

        public getFile(path: string, options?: { followSymlinks?: boolean, pattern?: RegExp }): VirtualFile | undefined {
            return this.root.getFile(vpath.resolve(this.currentDirectory, path), options);
        }

        public getDirectory(path: string, options?: { followSymlinks?: boolean, pattern?: RegExp }): VirtualDirectory | undefined {
            return this.root.getDirectory(vpath.resolve(this.currentDirectory, path), options);
        }

        public getAccessibleFileSystemEntries(path: string) {
            const entry = this.getEntry(path);
            if (entry instanceof VirtualDirectory) {
                return {
                    files: entry.getFiles().map(f => f.name),
                    directories: entry.getDirectories().map(d => d.name)
                };
            }
            return { files: [], directories: [] };
        }

        public shadow(): VirtualFileSystem {
            const fs = new VirtualFileSystem(this.currentDirectory, this.useCaseSensitiveFileNames);
            fs._shadowRoot = this;
            return fs;
        }

        public debugPrint(): void {
            console.log(`cwd: ${this.currentDirectory}`);
            for (const entry of this.getEntries({ recursive: true })) {
                if (entry instanceof VirtualDirectory) {
                    console.log(entry.path.endsWith("/") ? entry.path : entry.path + "/");
                    if (entry instanceof VirtualDirectorySymlink) {
                        console.log(`-> ${entry.target.endsWith("/") ? entry.target : entry.target + "/"}`);
                    }
                }
                else {
                    console.log(entry.path);
                    if (entry instanceof VirtualFileSymlink) {
                        console.log(`-> ${entry.target}`);
                    }
                }
            }
        }

        protected makeReadOnlyCore() {
            this.root.makeReadOnly();
        }

        protected getOwnEntries() {
            return this.root["getOwnEntries"]();
        }
    }

    export class VirtualDirectory extends VirtualFileSystemContainer {
        protected _shadowRoot: VirtualDirectory | undefined;
        private _parent: VirtualFileSystemContainer;
        private _entries: KeyedCollection<string, VirtualFile | VirtualDirectory> | undefined;
        // private _resolver: FileSystemResolver | undefined;

        constructor(parent: VirtualFileSystemContainer, name: string /*, resolver?: FileSystemResolver */) {
            super(name);
            this._parent = parent;
            this._entries = undefined;
            // this._resolver = resolver;
            this._shadowRoot = undefined;
        }

        public get parent(): VirtualFileSystemContainer {
            return this._parent;
        }

        public get shadowRoot(): VirtualDirectory | undefined {
            return this._shadowRoot;
        }

        public getEntry(path: string, options: { followSymlinks?: boolean, pattern?: RegExp, kind: "file" }): VirtualFile | undefined;
        public getEntry(path: string, options: { followSymlinks?: boolean, pattern?: RegExp, kind: "directory" }): VirtualDirectory | undefined;
        public getEntry(path: string, options?: { followSymlinks?: boolean, pattern?: RegExp, kind?: "file" | "directory" }): VirtualFile | VirtualDirectory | undefined;
        public getEntry(path: string, options: { followSymlinks?: boolean, pattern?: RegExp, kind?: "file" | "directory" } = {}): VirtualFile | VirtualDirectory | undefined {
            const components = this.parsePath(path);
            const directory = this.walkContainers(components, /*create*/ false);
            return directory && directory.getOwnEntry(components[components.length - 1], options);
        }

        public addDirectory(path: string /*, resolver?: FileSystemResolver*/): VirtualDirectory | undefined {
            this.writePreamble();
            const components = this.parsePath(path);
            const directory = this.walkContainers(components, /*create*/ true);
            return directory && directory.addOwnDirectory(components[components.length - 1] /*, resolver*/);
        }

        public addFile(path: string, content?: /*FileSystemResolver["getContent"] |*/ string | undefined, options?: { overwrite?: boolean }): VirtualFile | undefined {
            this.writePreamble();
            const components = this.parsePath(path);
            const directory = this.walkContainers(components, /*create*/ true);
            return directory && directory.addOwnFile(components[components.length - 1], content, options);
        }

        public addSymlink(path: string, target: VirtualFile): VirtualFileSymlink | undefined;
        public addSymlink(path: string, target: VirtualDirectory): VirtualDirectorySymlink | undefined;
        public addSymlink(path: string, target: string | VirtualFile | VirtualDirectory): VirtualSymlink | undefined;
        public addSymlink(path: string, target: string | VirtualFile | VirtualDirectory): VirtualSymlink | undefined {
            this.writePreamble();
            const targetEntry = typeof target === "string" ? this.fileSystem.getEntry(vpath.resolve(this.path, target)) : target;
            if (targetEntry === undefined) return undefined;
            const components = this.parsePath(path);
            const directory = this.walkContainers(components, /*create*/ true);
            return directory && directory.addOwnSymlink(components[components.length - 1], targetEntry);
        }

        public removeDirectory(path: string): boolean {
            this.writePreamble();
            const components = this.parsePath(path);
            const directory = this.walkContainers(components, /*create*/ false);
            return directory ? directory.removeOwnDirectory(components[components.length - 1]) : false;
        }

        public removeFile(path: string): boolean {
            this.writePreamble();
            this.writePreamble();
            const components = this.parsePath(path);
            const directory = this.walkContainers(components, /*create*/ false);
            return directory ? directory.removeOwnFile(components[components.length - 1]) : false;
        }

        public shadow(parent: VirtualFileSystemContainer): VirtualDirectory {
            this.shadowPreamble(parent);
            const shadow = new VirtualDirectory(parent, this.name);
            shadow._shadowRoot = this;
            return shadow;
        }

        protected makeReadOnlyCore(): void {
            if (this._entries) {
                this._entries.forEach(entry => entry.makeReadOnly());
            }
        }

        protected getOwnEntries() {
            if (!this._entries) {
                // const resolver = this._resolver;
                const entries = new KeyedCollection<string, VirtualFile | VirtualDirectory>(this.fileSystem.useCaseSensitiveFileNames ? compareStrings.caseSensitive : compareStrings.caseInsensitive);
                // this._resolver = undefined;
                /*if (resolver) {
                    const { files, directories } = resolver.getEntries(this);
                    for (const dir of directories) {
                        const vdir = new VirtualDirectory(this, dir, resolver);
                        if (this.isReadOnly) vdir.makeReadOnly();
                        entries.set(vdir.name, vdir);
                    }
                    for (const file of files) {
                        const vfile = new VirtualFile(this, file, file => resolver.getContent(file));
                        if (this.isReadOnly) vfile.makeReadOnly();
                        entries.set(vfile.name, vfile);
                    }
                }
                else*/ if (this._shadowRoot) {
                    this._shadowRoot.getOwnEntries().forEach(entry => {
                        const clone = <VirtualFile | VirtualDirectory>(<VirtualFileSystemEntry>entry).shadow(this);
                        if (this.isReadOnly) clone.makeReadOnly();
                        entries.set(clone.name, clone);
                    });
                }
                this._entries = entries;
            }
            return this._entries;
        }

        private parsePath(path: string) {
            return vpath.parse(vpath.normalize(path));
        }

        private walkContainers(components: string[], create: boolean) {
            // no absolute paths (unless this is the root)
            if (!!components[0] === !(this.parent instanceof VirtualFileSystem)) return undefined;

            // no relative paths
            if (components[1] === "..") return undefined;

            // walk the components
            let directory: VirtualDirectory | undefined = this;
            for (let i = this.parent instanceof VirtualFileSystem ? 0 : 1; i < components.length - 1; i++) {
                directory = create ? directory.getOrAddOwnDirectory(components[i]) : directory.getOwnDirectory(components[i]);
                if (directory === undefined) return undefined;
            }

            return directory;
        }

        private getOwnEntry(name: string, options: { followSymlinks?: boolean, pattern?: RegExp, kind: "file" }): VirtualFile | undefined;
        private getOwnEntry(name: string, options: { followSymlinks?: boolean, pattern?: RegExp, kind: "directory" }): VirtualDirectory | undefined;
        private getOwnEntry(name: string, options?: { followSymlinks?: boolean, pattern?: RegExp, kind?: "file" | "directory" }): VirtualFile | VirtualDirectory | undefined;
        private getOwnEntry(name: string, options: { followSymlinks?: boolean, pattern?: RegExp, kind?: "file" | "directory" } = {}): VirtualFile | VirtualDirectory | undefined {
            const entry = this.getOwnEntries().get(name);
            return entry && isMatch(entry, options) ? options.followSymlinks ? this.fileSystem.getRealEntry(entry) : entry : undefined;
        }

        private getOwnDirectory(name: string) {
            return this.getOwnEntry(name, { kind: "directory" });
        }

        private getOrAddOwnDirectory(name: string) {
            return this.getOwnDirectory(name) || this.addOwnDirectory(name);
        }

        private addOwnDirectory(name: string /*, resolver?: FileSystemResolver */): VirtualDirectory | undefined {
            const existing = this.getOwnEntry(name);
            if (existing) {
                if (/*!resolver &&*/ existing instanceof VirtualDirectory) {
                    return existing;
                }
                return undefined;
            }

            const entry = new VirtualDirectory(this, name /*, resolver */);
            this.getOwnEntries().set(entry.name, entry);
            this.raiseOnChildAdded(entry);
            return entry;
        }

        private addOwnFile(name: string, content?: /*FileSystemResolver["getContent"]*/ | string | undefined, options: { overwrite?: boolean } = {}): VirtualFile | undefined {
            const existing = this.getOwnEntry(name);
            if (existing) {
                if (!options.overwrite || !(existing instanceof VirtualFile)) {
                    return undefined;
                }

                // Remove the existing entry
                this.getOwnEntries().delete(name);
            }

            const entry = new VirtualFile(this, name, content);
            this.getOwnEntries().set(entry.name, entry);
            this.raiseOnChildAdded(entry);
            return entry;
        }

        private addOwnSymlink(name: string, target: VirtualFile | VirtualDirectory): VirtualSymlink | undefined {
            if (this.getOwnEntry(name)) return undefined;
            const entry = target instanceof VirtualFile ? new VirtualFileSymlink(this, name, target.path) : new VirtualDirectorySymlink(this, name, target.path);
            this.getOwnEntries().set(entry.name, entry);
            this.raiseOnChildAdded(entry);
            return entry;
        }

        private removeOwnDirectory(name: string) {
            const entries = this.getOwnEntries();
            const entry = entries.get(name);
            if (entry instanceof VirtualDirectory) {
                entries.delete(name);
                this.raiseOnChildRemoved(entry);
                return true;
            }
            return false;
        }

        private removeOwnFile(name: string) {
            const entries = this.getOwnEntries();
            const entry = entries.get(name);
            if (entry instanceof VirtualFile) {
                entries.delete(name);
                this.raiseOnChildRemoved(entry);
                return true;
            }
            return false;
        }
    }

    export class VirtualDirectorySymlink extends VirtualDirectory {
        private _targetPath: string;
        private _target: VirtualDirectory | undefined;
        private _symLinks = new Map<VirtualFile | VirtualDirectory, VirtualSymlink>();
        private _symEntries: KeyedCollection<string, VirtualSymlink> | undefined;
        private _onTargetParentChildRemoved: (entry: VirtualFile | VirtualDirectory) => void;
        private _onTargetChildRemoved: (entry: VirtualFile | VirtualDirectory) => void;
        private _onTargetChildAdded: (entry: VirtualFile | VirtualDirectory) => void;

        constructor(parent: VirtualFileSystemContainer, name: string, target: string) {
            super(parent, name);
            this._targetPath = target;
            this._onTargetParentChildRemoved = entry => this.onTargetParentChildRemoved(entry);
            this._onTargetChildAdded = entry => this.onTargetChildAdded(entry);
            this._onTargetChildRemoved = entry => this.onTargetChildRemoved(entry);
        }

        public get target() {
            return this._targetPath;
        }

        public set target(value: string) {
            this.writePreamble();
            if (this._targetPath !== value) {
                this._targetPath = value;
                this.invalidateTarget();
            }
        }

        public get isBroken(): boolean {
            return this.getRealDirectory() === undefined;
        }

        public getRealDirectory(): VirtualDirectory | undefined {
            this.resolveTarget();
            return this._target;
        }

        public addDirectory(path: string /*, resolver?: FileSystemResolver*/): VirtualDirectory | undefined {
            const target = this.getRealDirectory();
            return target && target.addDirectory(path /*, resolver*/);
        }

        public addFile(path: string, content?: /*FileSystemResolver["getContent"]*/ | string | undefined): VirtualFile | undefined {
            const target = this.getRealDirectory();
            return target && target.addFile(path, content);
        }

        public removeDirectory(path: string): boolean {
            const target = this.getRealDirectory();
            return target && target.removeDirectory(path) || false;
        }

        public removeFile(path: string): boolean {
            const target = this.getRealDirectory();
            return target && target.removeFile(path) || false;
        }

        public shadow(parent: VirtualFileSystemContainer): VirtualDirectorySymlink {
            this.shadowPreamble(parent);
            const shadow = new VirtualDirectorySymlink(parent, this.name, this.target);
            shadow._shadowRoot = this;
            return shadow;
        }

        public resolveTarget(): void {
            if (!this._target) {
                const entry = findTarget(this.fileSystem, this.target);
                if (entry instanceof VirtualDirectory) {
                    this._target = entry;
                    this._target.parent.addOnChildRemoved(this._onTargetParentChildRemoved);
                    this._target.addOnChildAdded(this._onTargetChildAdded);
                    this._target.addOnChildRemoved(this._onTargetChildRemoved);
                }
            }
        }

        protected getOwnEntries(): KeyedCollection<string, VirtualSymlink> {
            if (!this._symEntries) {
                const target = this.getRealDirectory();
                this._symEntries = new KeyedCollection<string, VirtualSymlink>(this.fileSystem.useCaseSensitiveFileNames ? compareStrings.caseSensitive : compareStrings.caseInsensitive);
                if (target) {
                    for (const entry of target.getEntries()) {
                        this._symEntries.set(entry.name, this.getWrappedEntry(entry));
                    }
                }
            }
            return this._symEntries;
        }

        private getWrappedEntry(entry: VirtualFile | VirtualDirectory) {
            let symlink = this._symLinks.get(entry);
            if (entry instanceof VirtualFile) {
                if (symlink instanceof VirtualFileSymlink) {
                    return symlink;
                }
                symlink = new VirtualFileSymlink(this, entry.name, entry.path);
                this._symLinks.set(entry, symlink);
            }
            else {
                if (symlink instanceof VirtualDirectorySymlink) {
                    return symlink;
                }
                symlink = new VirtualDirectorySymlink(this, entry.name, entry.path);
                this._symLinks.set(entry, symlink);
            }
            return symlink;
        }

        private onTargetParentChildRemoved(entry: VirtualFileSystemEntry) {
            if (entry !== this._target) return;
            this.invalidateTarget();
        }

        private onTargetChildAdded(entry: VirtualFile | VirtualDirectory) {
            const wrapped = this.getWrappedEntry(entry);
            this.getOwnEntries().set(entry.name, wrapped);
            this.raiseOnChildAdded(wrapped);
        }

        private onTargetChildRemoved(entry: VirtualFile | VirtualDirectory) {
            const wrapped = this.getWrappedEntry(entry);
            this.getOwnEntries().delete(entry.name);
            this._symLinks.delete(entry);
            this.raiseOnChildRemoved(wrapped);
        }

        private invalidateTarget() {
            if (!this._target) return;
            this._target.parent.removeOnChildRemoved(this._onTargetParentChildRemoved);
            this._target.removeOnChildAdded(this._onTargetChildAdded);
            this._target.removeOnChildRemoved(this._onTargetChildRemoved);
            this._target = undefined;
            this._symLinks.clear();
            this._symEntries = undefined;
        }
    }

    export class VirtualFile extends VirtualFileSystemEntry {
        protected _shadowRoot: VirtualFile | undefined;
        private _parent: VirtualDirectory;
        private _content: string | undefined;
        private _contentWasSet: boolean;
        // private _resolver: FileSystemResolver["getContent"] | undefined;

        constructor(parent: VirtualDirectory, name: string, content?: /*FileSystemResolver["getContent"]*/ | string | undefined) {
            super(name);
            this._parent = parent;
            this._content = typeof content === "string" ? content : undefined;
            // this._resolver = typeof content === "function" ? content : undefined;
            this._shadowRoot = undefined;
            this._contentWasSet = this._content !== undefined;
        }

        public get parent(): VirtualDirectory {
            return this._parent;
        }

        public get shadowRoot(): VirtualFile | undefined {
            return this._shadowRoot;
        }

        public getContent(): string | undefined {
            if (!this._contentWasSet) {
                // const resolver = this._resolver;
                const shadowRoot = this._shadowRoot;
                /* if (resolver) {
                    this._content = resolver(this);
                    this._contentWasSet = true;
                }
                else */ if (shadowRoot) {
                    this._content = shadowRoot.getContent();
                    this._contentWasSet = true;
                }
            }
            return this._content;
        }

        public setContent(value: string | undefined) {
            this.writePreamble();
            // this._resolver = undefined;
            this._content = value;
            this._contentWasSet = true;
        }

        public shadow(parent: VirtualDirectory): VirtualFile {
            this.shadowPreamble(parent);
            const shadow = new VirtualFile(parent, this.name);
            shadow._shadowRoot = this;
            shadow._contentWasSet = false;
            return shadow;
        }

        protected makeReadOnlyCore(): void {
        }
    }

    export class VirtualFileSymlink extends VirtualFile {
        private _target: string;

        constructor(parent: VirtualDirectory, name: string, target: string) {
            super(parent, name);
            this._target = target;
        }

        public get target(): string {
            return this._target;
        }

        public set target(value: string) {
            this.writePreamble();
            this._target = value;
        }

        public get isBroken(): boolean {
            return this.getRealFile() === undefined;
        }

        public getRealFile(): VirtualFile | undefined {
            const entry = findTarget(this.fileSystem, this.target);
            return entry instanceof VirtualFile ? entry : undefined;
        }

        public getContent(): string | undefined {
            const target = this.getRealFile();
            return target && target.getContent();
        }

        public setContent(value: string | undefined) {
            const target = this.getRealFile();
            if (target) target.setContent(value);
        }

        public shadow(parent: VirtualDirectory) {
            this.shadowPreamble(parent);
            const shadow = new VirtualFileSymlink(parent, this.name, this.target);
            shadow._shadowRoot = this;
            return shadow;
        }
    }

    export type VirtualSymlink = VirtualDirectorySymlink | VirtualFileSymlink;

    function findTarget(vfs: VirtualFileSystem, target: string, set?: Set<VirtualFileSymlink | VirtualDirectorySymlink>): VirtualFile | VirtualDirectory | undefined {
        const entry = vfs.getEntry(target);
        if (entry instanceof VirtualFileSymlink || entry instanceof VirtualDirectorySymlink) {
            if (!set) set = new Set<VirtualFileSymlink | VirtualDirectorySymlink>();
            if (set.has(entry)) return undefined;
            set.add(entry);
            return findTarget(vfs, entry.target, set);
        }
        return entry;
    }

    function isMatch(entry: VirtualFile | VirtualDirectory, options: { pattern?: RegExp, kind?: "file" | "directory" }) {
        return (options.pattern === undefined || options.pattern.test(entry.name))
            && (options.kind !== (entry instanceof VirtualFile ? "directory" : "file"));
    }

    // TODO(rbuckton): Move or retire this.
    export class MockParseConfigHost extends VirtualFileSystem implements ts.ParseConfigHost {
        constructor(currentDirectory: string, ignoreCase: boolean, files: ts.Map<string> | string[]) {
            super(currentDirectory, ignoreCase);
            if (files instanceof Array) {
                for (const file of files) {
                    // this.addFile(file, new Harness.LanguageService.ScriptInfo(file, undefined, /*isRootFile*/false));
                    this.addFile(file).metadata.set("scriptInfo", new Harness.LanguageService.ScriptInfo(file, undefined, /*isRootFile*/ false));
                }
            }
            else {
                files.forEach((fileContent, fileName) => {
                    this.addFile(fileName, fileContent).metadata.set("scriptInfo", new Harness.LanguageService.ScriptInfo(fileName, fileContent, /*isRootFile*/ false));
                });
            }
        }

        readDirectory(path: string, extensions: ReadonlyArray<string>, excludes: ReadonlyArray<string>, includes: ReadonlyArray<string>, depth: number) {
            return ts.matchFiles(path, extensions, excludes, includes, this.useCaseSensitiveFileNames, this.currentDirectory, depth, (path: string) => this.getAccessibleFileSystemEntries(path));
        }
    }
}