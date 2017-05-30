import {
    action,
    computed, reaction
} from "mobx"
import { AbstractNode } from "./abstract-node"
import { IType } from "../../types/type"

export class ComplexNode extends AbstractNode  {
    type: ComplexType<any, any>
    readonly storedValue: any
    isProtectionEnabled = true
    _environment: any = undefined
    _isRunningAction = false // only relevant for root
    private _isAlive = true // optimization: use binary flags for all these switches
    private _isDetaching = false

    readonly middlewares: IMiddleWareHandler[] = []
    private readonly snapshotSubscribers: ((snapshot: any) => void)[] = []
    private readonly patchSubscribers: ((patches: IJsonPatch) => void)[] = []
    private readonly disposers: (() => void)[] = []

    // TODO: reorder argumetns
    constructor(parent: ComplexNode | null, subpath: string, initialState: any, type: ComplexType<any, any>, environment: any) {
        super(type, parent, subpath, initialState)
        if (!(type instanceof ComplexType)) fail("Uh oh")
        addHiddenFinalProp(initialState, "$treenode", this)
        this._environment = environment

        // optimization: don't keep the snapshot by default alive with a reaction by default
        // in prod mode. This saves lot of GC overhead (important for e.g. React Native)
        // if the feature is not actively used
        // downside; no structural sharing if getSnapshot is called incidently
        const snapshotDisposer = reaction(() => this.snapshot, snapshot => {
            this.snapshotSubscribers.forEach(f => f(snapshot))
        })
        snapshotDisposer.onError((e: any) => {
            throw e
        })
        this.addDisposer(snapshotDisposer)
    }

    isLeaf() {
        return false
    }

    public get isAlive() {
        return this._isAlive
    }

    public die() {
        if (this._isDetaching)
            return

        walk(this.storedValue, child => getComplexNode(child).aboutToDie())
        walk(this.storedValue, child => getComplexNode(child).finalizeDeath())
    }

    public aboutToDie() {
        this.disposers.splice(0).forEach(f => f())
        this.fireHook("beforeDestroy")
    }

    public finalizeDeath() {
        // invariant: not called directly but from "die"
        const self = this
        const oldPath = this.path
        addReadOnlyProp(this, "snapshot", this.snapshot) // kill the computed prop and just store the last snapshot

        this.patchSubscribers.splice(0)
        this.snapshotSubscribers.splice(0)
        this.patchSubscribers.splice(0)
        this._isAlive = false
        this._parent = null
        this.subpath = ""

        // This is quite a hack, once interceptable objects / arrays / maps are extracted from mobx,
        // we could express this in a much nicer way
        Object.defineProperty(this.storedValue, "$mobx", {
            get() {
                fail(`This object has died and is no longer part of a state tree. It cannot be used anymore. The object (of type '${self.type.name}') used to live at '${oldPath}'. It is possible to access the last snapshot of this object using 'getSnapshot', or to create a fresh copy using 'clone'. If you want to remove an object from the tree without killing it, use 'detach' instead.`)
            }
        })
    }

    public assertAlive() {
        if (!this._isAlive)
            fail(`${this} cannot be used anymore as it has died; it has been removed from a state tree. If you want to remove an element from a tree and let it live on, use 'detach' or 'clone' the value`)
    }

    @computed public get snapshot() {
        if (!this._isAlive)
            return undefined
        // advantage of using computed for a snapshot is that nicely respects transactions etc.
        // Optimization: only freeze on dev builds
        return Object.freeze(this.type.serialize(this))
    }

    public onSnapshot(onChange: (snapshot: any) => void): IDisposer {
        return registerEventHandler(this.snapshotSubscribers, onChange)
    }

    public applySnapshot(snapshot: any) {
        typecheck(this.type, snapshot)
        return this.type.applySnapshot(this, snapshot)
    }

    @action public applyPatch(patch: IJsonPatch) {
        const parts = splitJsonPath(patch.path)
        const node = assertComplexNode(this.resolvePath(parts.slice(0, -1)))

        node.pseudoAction(() => {
            node.applyPatchLocally(parts[parts.length - 1], patch)
        })
    }

    applyPatchLocally(subpath: string, patch: IJsonPatch): void {
        this.assertWritable()
        this.type.applyPatchLocally(this, subpath, patch)
    }

    public onPatch(onPatch: (patches: IJsonPatch) => void): IDisposer {
        return registerEventHandler(this.patchSubscribers, onPatch)
    }

    emitPatch(patch: IJsonPatch, source: ComplexNode) {
        if (this.patchSubscribers.length) {
            const localizedPatch: IJsonPatch = extend({}, patch, {
                    path: source.path.substr(this.path.length) + "/" + patch.path // calculate the relative path of the patch
                })
            this.patchSubscribers.forEach(f => f(localizedPatch))
        }
        if (this.parent)
            this.parent.emitPatch(patch, source)
    }

    setParent(newParent: ComplexNode | null, subpath: string | null = null) {
        if (this.parent === newParent && this.subpath === subpath)
            return
        if (this._parent && newParent && newParent !== this._parent) {
            fail(`A node cannot exists twice in the state tree. Failed to add ${this} to path '${newParent.path}/${subpath}'.`)
        }
        if (!this._parent && newParent && newParent.root === this) {
            fail(`A state tree is not allowed to contain itself. Cannot assign ${this} to path '${newParent.path}/${subpath}'`)
        }
        if (!this._parent && !!this._environment) {
            fail(`A state tree that has been initialized with an environment cannot be made part of another state tree.`)
        }
        if (this.parent && !newParent) {
            this.die()
        } else {
            this._parent = newParent
            this.subpath = subpath || ""
            this.fireHook("afterAttach")
        }
    }

    addDisposer(disposer: () => void) {
        this.disposers.unshift(disposer)
    }

    reconcileChildren<T>(childType: IType<any, T>, oldNodes: AbstractNode[], newValues: T[], newPaths: (string|number)[]): T[] {
        // TODO: pick identifiers based on actual type instead of declared type
        // optimization: overload for a single old / new value to avoid all the array allocations
        // optimization: skip reconciler for non-complex types
        const res = new Array(newValues.length)
        const oldValuesByNode: any = {}
        const oldValuesById: any = {}
        const identifierAttribute = getIdentifierAttribute(childType)

        // Investigate which values we could reconcile
        oldNodes.forEach(oldNode => {
            const oldValue = oldNode.getValue() // MWE: TODO: what about broken refs?
            if (!oldValue)
                return
            if (identifierAttribute) {
                const id = (oldValue as any)[identifierAttribute]
                if (id)
                    oldValuesById[id] = oldValue
            }
            if (isComplexValue(oldValue)) {
                oldValuesByNode[getComplexNode(oldValue).nodeId] = oldValue
            }
        })

        // Prepare new values, try to reconcile
        newValues.forEach((newValue, index) => {
            const subPath = "" + newPaths[index]
            if (isComplexValue(newValue)) {
                // A tree node...
                const childNode = getComplexNode(newValue)
                childNode.assertAlive()
                if (childNode.parent && (childNode.parent !== this || !oldValuesByNode[childNode.nodeId]))
                    return fail(`Cannot add an object to a state tree if it is already part of the same or another state tree. Tried to assign an object to '${this.path}/${subPath}', but it lives already at '${childNode.path}'`)

                // Try to reconcile based on already existing nodes
                oldValuesByNode[childNode.nodeId] = undefined
                childNode.setParent(this, subPath)
                res[index] = newValue
            } else if (identifierAttribute && isMutable(newValue)) {
                // The snapshot of a tree node..
                typecheck(childType, newValue)

                // Try to reconcile based on id
                const id = (newValue as any)[identifierAttribute]
                const existing = oldValuesById[id]
                const childNode = existing && getComplexNode(existing)
                if (existing && childNode.type.is(newValue)) {
                    oldValuesByNode[childNode.nodeId] = undefined
                    childNode.setParent(this, subPath)
                    childNode.applySnapshot(newValue)
                    res[index] = existing
                } else {
                    res[index] = childType.instantiate(this, subPath, undefined, newValue)
                }
            } else {
                typecheck(childType, newValue)

                // create a fresh MST node
                res[index] = childType.instantiate(this, subPath, undefined, newValue)
            }
        })

        // Kill non reconciled values
        for (let key in oldValuesByNode) if (oldValuesByNode[key])
            getComplexNode(oldValuesByNode[key]).die()

        return res
    }


    isRunningAction(): boolean {
        if (this._isRunningAction)
            return true
        if (this.isRoot)
            return false
        return this.parent!.isRunningAction()
    }

    addMiddleWare(handler: IMiddleWareHandler) {
        // TODO: check / warn if not protected!
        return registerEventHandler(this.middlewares, handler)
    }

    getChildNode(subpath: string): AbstractNode {
        this.assertAlive()
        return this.type.getChildNode(this, subpath)
    }

    getChildren(): AbstractNode[] {
        return this.type.getChildren(this)
    }

    getChildType(key: string): IType<any, any> {
        return this.type.getChildType(key)
    }

    get isProtected(): boolean {
        let cur: ComplexNode | null = this
        while (cur) {
            if (cur.isProtectionEnabled === false)
                return false
            cur = cur.parent
        }
        return true
    }

    /**
     * Pseudo action is an action that is not named, does not trigger middleware but does unlock the tree.
     * Used for applying (initial) snapshots and patches
     */
    pseudoAction(fn: () => void) {
        const inAction = this._isRunningAction
        this._isRunningAction = true
        fn()
        this._isRunningAction = inAction
    }

    assertWritable() {
        this.assertAlive()
        if (!this.isRunningAction() && this.isProtected) {
            fail(`Cannot modify '${this}', the object is protected and can only be modified by using an action.`)
        }
    }

    removeChild(subpath: string) {
        this.type.removeChild(this, subpath)
    }

    detach() {
        if (!this._isAlive) fail(`Error while detaching, node is not alive.`)
        if (this.isRoot)
            return
        else {
            this.fireHook("beforeDetach")
            this._environment = (this.root as ComplexNode)._environment // make backup of environment
            this._isDetaching = true
            this.parent!.removeChild(this.subpath)
            this._parent = null
            this.subpath = ""
            this._isDetaching = false
        }
    }

    fireHook(name: string) {
        const fn = this.storedValue[name]
        if (typeof fn === "function")
            fn.apply(this.storedValue)
    }

    toString(): string {
        const identifierAttr = getIdentifierAttribute(this.type)
        const identifier = identifierAttr ? `(${identifierAttr}: ${this.storedValue[identifierAttr]})` : ""
        return `${this.type.name}@${this.path || "<root>"}${identifier}${this.isAlive ? "" : "[dead]"}`
    }
}

export interface IComplexValue {
    readonly $treenode?: ComplexNode
}

export function isComplexValue(value: any): value is IComplexValue {
    return value && value.$treenode
}

export function getComplexNode(value: IComplexValue): ComplexNode {
    if (isComplexValue(value))
        return value.$treenode!
    else
        return fail("element has no Node")
}

function assertComplexNode(thing: AbstractNode | null): ComplexNode {
    if (thing instanceof ComplexNode)
        return thing
    return fail("Not a complex node: " + thing)
}

import { typecheck } from "../../types/type-checker"
import { walk } from "../mst-operations"
import { IMiddleWareHandler } from "../action"
import {
    addHiddenFinalProp,
    addReadOnlyProp,
    extend,
    fail,
    IDisposer,
    isMutable,
    registerEventHandler
} from "../../utils"
import { IJsonPatch, joinJsonPath, splitJsonPath } from "../json-patch"
import { getIdentifierAttribute } from "../../types/complex-types/object"
import { ComplexType } from "../../types/complex-types/complex-type"
