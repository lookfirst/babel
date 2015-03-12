import isBoolean from "lodash/lang/isBoolean";
import isNumber from "lodash/lang/isNumber";
import isRegExp from "lodash/lang/isRegExp";
import isString from "lodash/lang/isString";
import traverse from "./index";
import includes from "lodash/collection/includes";
import Scope from "./scope";
import * as t from "../types";

export default class TraversalPath {
  constructor(parent, container) {
    this.container = container;
    this.parent    = parent;
    this.data      = {};
  }

  static get(parentPath: TraversalPath, context?: TraversalContext, parent, container, key, file?: File) {
    var targetNode = container[key];
    var paths = container._paths ||= [];
    var path;

    for (var i = 0; i < paths.length; i++) {
      var pathCheck = paths[i];
      if (pathCheck.node === targetNode) {
        path = pathCheck;
        break;
      }
    }

    if (!path) {
      path = new TraversalPath(parent, container);
      paths.push(path);
    }

    path.setContext(parentPath, context, key, file);

    return path;
  }

  static getScope(path: TraversalPath, scope: Scope, file?: File) {
    var ourScope = scope;

    // we're entering a new scope so let's construct it!
    if (path.isScope()) {
      ourScope = new Scope(path, scope, file);
    }

    return ourScope;
  }

  insertBefore(node) {

  }

  insertAfter(node) {

  }

  setData(key, val) {
    return this.data[key] = val;
  }

  getData(key) {
    return this.data[key];
  }

  setScope(file?) {
    this.scope = TraversalPath.getScope(this, this.context && this.context.scope, file);
  }

  setContext(parentPath, context, key, file?) {
    this.shouldSkip = false;
    this.shouldStop = false;

    this.parentPath = parentPath || this.parentPath;
    this.key        = key;

    if (context) {
      this.context = context;
      this.state   = context.state;
      this.opts    = context.opts;
    }

    this.setScope(file);
  }

  remove() {
    this._refresh(this.node, []);
    this.container[this.key] = null;
    this.flatten();
  }

  skip() {
    this.shouldSkip = true;
  }

  stop() {
    this.shouldStop = true;
    this.shouldSkip = true;
  }

  flatten() {
    this.context.flatten();
  }

  _refresh(oldNode, newNodes) {
    // todo
  }

  refresh() {
    var node = this.node;
    this._refresh(node, [node]);
  }

  get node() {
    return this.container[this.key];
  }

  set node(replacement) {
    if (!replacement) return this.remove();

    var oldNode      = this.node;
    var isArray      = Array.isArray(replacement);
    var replacements = isArray ? replacement : [replacement];

    // inherit comments from original node to the first replacement node
    var inheritTo = replacements[0];
    if (inheritTo) t.inheritsComments(inheritTo, oldNode);

    // replace the node
    this.container[this.key] = replacement;

    // potentially create new scope
    this.setScope();

    // refresh scope with new/removed bindings
    this._refresh(oldNode, replacements);

    var file = this.scope && this.scope.file;
    if (file) {
      for (var i = 0; i < replacements.length; i++) {
        file.checkNode(replacements[i], this.scope);
      }
    }

    // we're replacing a statement or block node with an array of statements so we better
    // ensure that it's a block
    if (isArray) {
      if (includes(t.STATEMENT_OR_BLOCK_KEYS, this.key) && !t.isBlockStatement(this.container)) {
        t.ensureBlock(this.container, this.key);
      }

      this.flatten();
      // TODO: duplicate internal path metadata across the new node paths
    }
  }

  call(key) {
    var node = this.node;
    if (!node) return;

    var opts = this.opts;
    var fn   = opts[key] || opts;
    if (opts[node.type]) fn = opts[node.type][key] || fn;

    var replacement = fn.call(this, node, this.parent, this.scope, this.state);

    if (replacement) {
      this.node = replacement;
    }
  }

  isBlacklisted() {
    var blacklist = this.opts.blacklist;
    return blacklist && blacklist.indexOf(this.node.type) > -1;
  }

  visit() {
    if (this.isBlacklisted()) return false;

    this.call("enter");

    if (this.shouldSkip) {
      return this.shouldStop;
    }

    var node = this.node;
    var opts = this.opts;

    if (node) {
      if (Array.isArray(node)) {
        // traverse over these replacement nodes we purposely don't call exitNode
        // as the original node has been destroyed
        for (var i = 0; i < node.length; i++) {
          traverse.node(node[i], opts, this.scope, this.state, this);
        }
      } else {
        traverse.node(node, opts, this.scope, this.state, this);
        this.call("exit");
      }
    }

    return this.shouldStop;
  }

  get(key) {
    var node = this.node;
    var container = node[key];
    if (Array.isArray(container)) {
      return container.map((_, i) => {
        return TraversalPath.get(this, this.context, node, container, i);
      });
    } else {
      return TraversalPath.get(this, this.context, node, node, key);
    }
  }

  has(key) {
    return !!this.node[key];
  }

  getTypeAnnotation(): Object {
    if (this.typeInfo) {
      return this.typeInfo;
    }

    var info = this.typeInfo = {
      inferred: false,
      annotation: null
    };

    var type = this.node.typeAnnotation;

    if (!type) {
      info.inferred = true;
      type = this.inferType(this);
    }

    if (type) {
      if (t.isTypeAnnotation(type)) type = type.typeAnnotation;
      info.annotation = type;
    }

    return info;
  }

  resolve(): ?TraversalPath {
    if (this.isVariableDeclarator()) {
      return this.get("init").resolve();
    } else if (this.isIdentifier()) {
      var binding = this.scope.getBinding(this.node.name);
      if (!binding) return;

      if (binding.path === this) {
        return this;
      } else {
        return binding.path.resolve();;
      }
    } else if (this.isMemberExpression()) {
      var targetKey = t.toComputedKey(this.node);
      if (!t.isLiteral(targetKey)) return;
      var targetName = targetKey.value;

      var target = this.get("object").resolve();
      if (!target || !target.isObjectExpression()) return;

      var props = target.get("properties");
      for (var i = 0; i < props.length; i++) {
        var prop = props[i];
        if (!prop.isProperty()) continue;

        var key = prop.get("key");
        if (key.isIdentifier({ name: targetName }) || key.isLiteral({ value: targetName })) {
          return prop.get("value");
        }
      }
    } else {
      return this;
    }
  }

  inferType(path: TraversalPath) {
    path = path.resolve();
    if (!path) return;

    if (path.isRestElement() || path.isArrayExpression()) {
      return t.genericTypeAnnotation(t.identifier("Array"));
    }

    if (path.isObjectExpression()) {
      return t.genericTypeAnnotation(t.identifier("Object"));
    }

    if (path.isLiteral()) {
      var value = path.node.value;
      if (isString(value)) return t.stringTypeAnnotation();
      if (isNumber(value)) return t.numberTypeAnnotation();
      if (isBoolean(value)) return t.booleanTypeAnnotation();
    }

    if (path.isCallExpression()) {
      var callee = path.get("callee").resolve();
      if (callee && callee.isFunction()) return callee.node.returnType;
    }
  }

  isScope() {
    return t.isScope(this.node, this.parent);
  }

  isReferencedIdentifier(opts) {
    return t.isReferencedIdentifier(this.node, this.parent, opts);
  }

  isReferenced() {
    return t.isReferenced(this.node, this.parent);
  }

  isBlockScoped() {
    return t.isBlockScoped(this.node);
  }

  isVar() {
    return t.isVar(this.node);
  }

  isScope() {
    return t.isScope(this.node, this.parent);
  }

  isTypeGeneric(genericName: string, hasTypeParameters?): boolean {
    var type = this.getTypeAnnotation().annotation;
    if (!type) return false;

    if (!t.isGenericTypeAnnotation(type) || !t.isIdentifier(type.id, { name: genericName })) {
      return false;
    }

    if (hasTypeParameters && !type.typeParameters) {
      return false;
    }

    return true;
  }

  getBindingIdentifiers() {
    return t.getBindingIdentifiers(this.node);
  }

  traverse(opts, state) {
    traverse(this.node, opts, this.scope, state);
  }
}

for (var i = 0; i < t.TYPES.length; i++) {
  let type = t.TYPES[i];
  let typeKey = `is${type}`;
  TraversalPath.prototype[typeKey] = function (opts) {
    return t[typeKey](this.node, opts);
  };
}
