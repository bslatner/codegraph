import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText, getChildByField } from '../tree-sitter-helpers';
import type { LanguageExtractor, ExtractorContext } from '../tree-sitter-types';

/**
 * F# extractor — ionide/tree-sitter-fsharp grammar (vendored wasm; the npm
 * `tree-sitter-fsharp` package ships a prebuilt ABI-14 build).
 *
 * Structure the grammar gives us (see dump-ast on any .fs file):
 * - `namespace` / `named_module` carry a `name:` long_identifier field;
 *   `module_defn` (nested `module M =`) has a bare identifier child.
 * - Every `let` is a `function_or_value_defn` whose first child is either a
 *   `function_declaration_left` (has argument_patterns → a function) or a
 *   `value_declaration_left` (a value binding). The defn has a `body:` field.
 * - Type definitions are wrapped in `type_definition` with one variant child
 *   per `and`-joined type: `record_type_defn`, `union_type_defn`,
 *   `enum_type_defn`, `anon_type_defn` (classes AND `abstract member`-style
 *   interfaces — distinguished structurally below), `interface_type_defn`,
 *   `delegate_type_defn`, `type_abbrev_defn`, `type_extension`.
 * - Members are `member_defn > method_or_prop_defn` with `name:`
 *   property_or_ident ("this.Log" — the receiver prefix is stripped here) and
 *   an `args:` field only when parameterized; abstract members are
 *   `member_defn > member_signature`.
 * - Calls are `application_expression` (no `function` field — the callee is
 *   the first named child) and pipe/composition `infix_expression`s; both are
 *   handled by the fsharp branch in TreeSitterExtractor.extractCall.
 */

/** Dotted name from identifier / long_identifier / long_identifier_or_op, e.g. "List.map". */
export function fsharpDottedName(node: SyntaxNode | null, source: string): string | null {
  if (!node) return null;
  if (node.type === 'identifier') return getNodeText(node, source);
  if (node.type === 'long_identifier_or_op') {
    return fsharpDottedName(node.namedChild(0), source);
  }
  if (node.type === 'long_identifier') {
    const parts: string[] = [];
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child?.type === 'identifier') parts.push(getNodeText(child, source));
    }
    return parts.length > 0 ? parts.join('.') : null;
  }
  return null;
}

/** The `function_declaration_left` / `value_declaration_left` child of a defn. */
function declarationLeft(node: SyntaxNode): SyntaxNode | null {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child?.type === 'function_declaration_left' || child?.type === 'value_declaration_left') {
      return child;
    }
  }
  return null;
}

/** Name of a value binding: value_declaration_left > identifier_pattern > long_identifier_or_op. */
function valueBindingName(left: SyntaxNode, source: string): string | null {
  for (let i = 0; i < left.namedChildCount; i++) {
    const child = left.namedChild(i);
    if (child?.type === 'identifier_pattern') {
      const name = fsharpDottedName(child.namedChild(0), source);
      if (name) return name;
    }
  }
  return null;
}

/** The identifier inside a type defn's `type_name` child. */
function typeDefnName(node: SyntaxNode, source: string): string | null {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child?.type === 'type_name') {
      const id = getChildByField(child, 'type_name') ?? child.namedChild(0);
      if (id) return getNodeText(id, source);
    }
  }
  return null;
}

function findAccessModifier(node: SyntaxNode): string | null {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child?.type === 'access_modifier') return child.text;
  }
  return null;
}

/**
 * Visibility of a defn/member: the access_modifier lives inside the
 * declaration_left (let bindings), on the member_defn parent (members), or on
 * the node itself (type defns).
 */
function fsharpVisibility(node: SyntaxNode): 'public' | 'private' | 'internal' | undefined {
  const candidates: SyntaxNode[] = [node];
  const left = node.type === 'function_or_value_defn' ? declarationLeft(node) : null;
  if (left) candidates.push(left);
  if (node.parent?.type === 'member_defn') candidates.push(node.parent);
  for (const c of candidates) {
    const mod = findAccessModifier(c);
    if (mod === 'private') return 'private';
    if (mod === 'internal') return 'internal';
    if (mod === 'public') return 'public';
  }
  return undefined;
}

/** True when an anon_type_defn is an interface: no primary constructor and
 *  every member is an abstract `member_signature` (`type I = abstract member …`). */
function isInterfaceShaped(node: SyntaxNode): boolean {
  let sawSignature = false;
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;
    if (child.type === 'primary_constr_args') return false;
    if (child.type !== 'type_extension_elements') continue;
    for (let j = 0; j < child.namedChildCount; j++) {
      const el = child.namedChild(j);
      if (!el) continue;
      if (el.type === 'member_defn') {
        let abstract = false;
        for (let k = 0; k < el.namedChildCount; k++) {
          if (el.namedChild(k)?.type === 'member_signature') abstract = true;
        }
        if (!abstract) return false;
        sawSignature = true;
      } else if (el.type !== 'attributes') {
        return false; // let bindings, interface impls, inherits → concrete type
      }
    }
  }
  return sawSignature;
}

/** Type name referenced by an `inherit`/`interface … with` clause (last-dot-stripped). */
function referencedTypeName(node: SyntaxNode, source: string): string | null {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;
    if (child.type === 'simple_type' || child.type === 'generic_type' || child.type === 'long_identifier') {
      const text = getNodeText(child, source).replace(/<[^>]*>/g, '').trim();
      const last = text.split('.').pop();
      if (last && /^[A-Za-z_]\w*$/.test(last)) return last;
    }
  }
  return null;
}

/** Extract one type-definition variant (record/union/enum/class/interface/alias). */
function extractTypeVariant(node: SyntaxNode, ctx: ExtractorContext): void {
  const name = typeDefnName(node, ctx.source);
  if (!name) return;
  const t = node.type;

  if (t === 'type_abbrev_defn' || t === 'delegate_type_defn') {
    ctx.createNode('type_alias', name, node);
    return;
  }

  if (t === 'union_type_defn' || t === 'enum_type_defn') {
    // `type Distance = float` parses as a single bare (fieldless) union case —
    // the grammar can't tell an abbreviation from a one-case DU. Treat a single
    // fieldless case as a type alias.
    const caseType = t === 'union_type_defn' ? 'union_type_case' : 'enum_type_case';
    const cases: SyntaxNode[] = [];
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child?.type !== `${caseType}s`) continue;
      for (let j = 0; j < child.namedChildCount; j++) {
        const c = child.namedChild(j);
        if (c?.type === caseType) cases.push(c);
      }
    }
    if (t === 'union_type_defn' && cases.length === 1) {
      const only = cases[0]!;
      const hasFields = only.namedChildren.some((c: SyntaxNode) => c.type === 'union_type_fields');
      if (!hasFields) {
        ctx.createNode('type_alias', name, node);
        return;
      }
    }
    const enumNode = ctx.createNode('enum', name, node, { visibility: fsharpVisibility(node) });
    if (!enumNode) return;
    ctx.pushScope(enumNode.id);
    for (const c of cases) {
      const id = c.namedChildren.find((ch: SyntaxNode) => ch.type === 'identifier');
      if (id) ctx.createNode('enum_member', getNodeText(id, ctx.source), c);
    }
    // Members on a DU (`type Shape = … member this.Area = …`) still extract.
    visitTypeBodyElements(node, ctx);
    ctx.popScope();
    return;
  }

  if (t === 'record_type_defn') {
    const structNode = ctx.createNode('struct', name, node, { visibility: fsharpVisibility(node) });
    if (!structNode) return;
    ctx.pushScope(structNode.id);
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child?.type !== 'record_fields') continue;
      for (let j = 0; j < child.namedChildCount; j++) {
        const field = child.namedChild(j);
        if (field?.type !== 'record_field') continue;
        const id = field.namedChildren.find((ch: SyntaxNode) => ch.type === 'identifier');
        if (id) ctx.createNode('field', getNodeText(id, ctx.source), field);
      }
    }
    visitTypeBodyElements(node, ctx);
    ctx.popScope();
    return;
  }

  // anon_type_defn (classes + abstract-member interfaces), interface_type_defn,
  // type_extension (`type Foo with …` — members extract scoped under the name).
  const kind =
    t === 'interface_type_defn' || (t === 'anon_type_defn' && isInterfaceShaped(node))
      ? 'interface'
      : 'class';
  const classNode = ctx.createNode(kind, name, node, { visibility: fsharpVisibility(node) });
  if (!classNode) return;
  ctx.pushScope(classNode.id);
  visitTypeBodyElements(node, ctx);
  ctx.popScope();
}

/**
 * Walk a type defn's `type_extension_elements` blocks: members and let
 * bindings dispatch through the standard walker; `interface X with …` emits an
 * `implements` edge and extracts its member implementations as methods of the
 * enclosing type; `inherit X …` emits `extends`.
 */
function visitTypeBodyElements(node: SyntaxNode, ctx: ExtractorContext): void {
  const ownerId = ctx.nodeStack[ctx.nodeStack.length - 1];
  for (let i = 0; i < node.namedChildCount; i++) {
    const block = node.namedChild(i);
    if (block?.type !== 'type_extension_elements') continue;
    for (let j = 0; j < block.namedChildCount; j++) {
      const el = block.namedChild(j);
      if (!el) continue;
      if (el.type === 'interface_implementation') {
        const ifaceName = referencedTypeName(el, ctx.source);
        if (ifaceName && ownerId) {
          ctx.addUnresolvedReference({
            fromNodeId: ownerId,
            referenceName: ifaceName,
            referenceKind: 'implements',
            line: el.startPosition.row + 1,
            column: el.startPosition.column,
          });
        }
        for (let k = 0; k < el.namedChildCount; k++) {
          const impl = el.namedChild(k);
          if (impl && impl.type !== 'simple_type' && impl.type !== 'generic_type') {
            ctx.visitNode(impl);
          }
        }
      } else if (el.type === 'class_inherits_decl') {
        const baseName = referencedTypeName(el, ctx.source);
        if (baseName && ownerId) {
          ctx.addUnresolvedReference({
            fromNodeId: ownerId,
            referenceName: baseName,
            referenceKind: 'extends',
            line: el.startPosition.row + 1,
            column: el.startPosition.column,
          });
        }
      } else {
        ctx.visitNode(el);
      }
    }
  }
}

export const fsharpExtractor: LanguageExtractor = {
  // function-shaped `let f x =` dispatches here (value-shaped `let v =` is
  // consumed by visitNode below before this list is consulted).
  functionTypes: ['function_or_value_defn'],
  classTypes: [], // all type defns handled in visitNode (multi-`block:` bodies)
  methodTypes: ['method_or_prop_defn', 'member_signature'],
  interfaceTypes: [],
  structTypes: [],
  enumTypes: [],
  enumMemberTypes: [],
  typeAliasTypes: [],
  importTypes: ['import_decl'],
  callTypes: ['application_expression', 'infix_expression'],
  variableTypes: [],

  nameField: 'name',
  bodyField: 'body',
  paramsField: 'args',

  resolveName: (node: SyntaxNode, source: string) => {
    if (node.type === 'function_or_value_defn') {
      const left = declarationLeft(node);
      // Only function-shaped defns get a name here — a value-shaped local
      // (`let x = …` inside a body) must stay <anonymous> so the body walker
      // doesn't mint a node per local variable.
      if (left?.type === 'function_declaration_left') {
        const id = left.namedChildren.find((c: SyntaxNode) => c.type === 'identifier');
        if (id) return getNodeText(id, source);
        // Operator definition: `let (|>>) f g = …`
        const op = left.namedChildren.find((c: SyntaxNode) => c.type === 'long_identifier_or_op');
        if (op) return getNodeText(op, source);
      }
      return undefined;
    }
    if (node.type === 'method_or_prop_defn') {
      const nameNode = getChildByField(node, 'name');
      if (nameNode) {
        // property_or_ident is "this.Log" / "_.Render" / bare "Zero" — strip the
        // self-identifier prefix.
        const text = getNodeText(nameNode, source);
        const last = text.split('.').pop();
        return last || text;
      }
      return undefined;
    }
    if (node.type === 'member_signature') {
      const id = node.namedChildren.find((c: SyntaxNode) => c.type === 'identifier');
      return id ? getNodeText(id, source) : undefined;
    }
    return undefined;
  },

  extractPropertyName: (node: SyntaxNode, source: string) => {
    // `member this.Value = …` — property_or_ident carries the receiver prefix.
    if (node.type !== 'method_or_prop_defn') return null;
    const nameNode = getChildByField(node, 'name');
    if (!nameNode) return null;
    const text = getNodeText(nameNode, source);
    return text.split('.').pop() || text;
  },

  classifyMethodNode: (node: SyntaxNode) => {
    if (node.type !== 'method_or_prop_defn') return 'method';
    // Parameterized members have an `args:` field; `member this.Value = …` is a property.
    return getChildByField(node, 'args') ? 'method' : 'property';
  },

  resolveBody: (node: SyntaxNode, bodyField: string) => {
    const direct = getChildByField(node, bodyField);
    if (direct) return direct;
    if (node.type !== 'method_or_prop_defn') return null;
    // The member body is the last named child after the name/args fields.
    const nameNode = getChildByField(node, 'name');
    const argsNode = getChildByField(node, 'args');
    for (let i = node.namedChildCount - 1; i >= 0; i--) {
      const child = node.namedChild(i);
      if (!child || child === nameNode || child === argsNode) continue;
      if (child.type === 'access_modifier' || child.type === 'attributes') continue;
      if (child.type === 'simple_type' || child.type === 'generic_type') continue; // return annotation
      return child;
    }
    return null;
  },

  getSignature: (node: SyntaxNode, source: string) => {
    if (node.type === 'function_or_value_defn') {
      const left = declarationLeft(node);
      if (left?.type !== 'function_declaration_left') return undefined;
      const args = left.namedChildren.find((c: SyntaxNode) => c.type === 'argument_patterns');
      let sig = args ? getNodeText(args, source) : '';
      // Return annotation is a sibling type node between the left and the body.
      const ret = node.namedChildren.find(
        (c: SyntaxNode) => c.type === 'simple_type' || c.type === 'generic_type' || c.type === 'function_type'
      );
      if (ret) sig += ` : ${getNodeText(ret, source)}`;
      return sig.trim() || undefined;
    }
    if (node.type === 'method_or_prop_defn') {
      const args = getChildByField(node, 'args');
      return args ? getNodeText(args, source) : undefined;
    }
    return undefined;
  },

  getVisibility: (node: SyntaxNode) => {
    const v = fsharpVisibility(node);
    // NodeKind visibility has no 'internal' member in some consumers; map it through.
    return v === 'internal' ? 'internal' : v;
  },

  isStatic: (node: SyntaxNode) => {
    // `static member Zero = …` — the `static` keyword is a token on the member_defn.
    const holder = node.parent?.type === 'member_defn' ? node.parent : node;
    for (let i = 0; i < holder.childCount; i++) {
      if (holder.child(i)?.type === 'static') return true;
    }
    return false;
  },

  getReturnType: (node: SyntaxNode, source: string) => {
    if (node.type !== 'function_or_value_defn') return undefined;
    const ret = node.namedChildren.find((c: SyntaxNode) => c.type === 'simple_type');
    if (!ret) return undefined;
    const raw = getNodeText(ret, source).replace(/<[^>]*>/g, '').trim();
    const last = raw.split('.').pop();
    return last && /^[A-Za-z_]\w*$/.test(last) ? last : undefined;
  },

  extractImport: (node: SyntaxNode, source: string) => {
    // `open System.Collections.Generic` — module path is the long_identifier child.
    const path = node.namedChildren.find((c: SyntaxNode) => c.type === 'long_identifier');
    if (!path) return null;
    return {
      moduleName: getNodeText(path, source),
      signature: getNodeText(node, source).trim(),
    };
  },

  visitNode: (node: SyntaxNode, ctx: ExtractorContext) => {
    const t = node.type;

    // ---- namespace / module containers ----
    if (t === 'namespace' || t === 'named_module') {
      const nameNode = getChildByField(node, 'name');
      const name = nameNode ? getNodeText(nameNode, ctx.source) : null;
      if (!name) return false;
      const container = ctx.createNode(t === 'namespace' ? 'namespace' : 'module', name, node);
      if (!container) return false;
      ctx.pushScope(container.id);
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child && child !== nameNode) ctx.visitNode(child);
      }
      ctx.popScope();
      return true;
    }
    if (t === 'module_defn') {
      const id = node.namedChildren.find((c: SyntaxNode) => c.type === 'identifier');
      if (!id) return false;
      const moduleNode = ctx.createNode('module', getNodeText(id, ctx.source), node);
      if (!moduleNode) return false;
      ctx.pushScope(moduleNode.id);
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child && child !== id && child.type !== 'attributes') ctx.visitNode(child);
      }
      ctx.popScope();
      return true;
    }

    // ---- type definitions ----
    if (t === 'type_definition') {
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child) ctx.visitNode(child);
      }
      return true;
    }
    if (
      t === 'record_type_defn' || t === 'union_type_defn' || t === 'enum_type_defn' ||
      t === 'anon_type_defn' || t === 'interface_type_defn' || t === 'type_abbrev_defn' ||
      t === 'delegate_type_defn' || t === 'type_extension'
    ) {
      extractTypeVariant(node, ctx);
      return true;
    }

    // ---- value bindings (module/class scope only — visitNode never runs
    // inside function bodies, those are walked by visitFunctionBody) ----
    if (t === 'function_or_value_defn') {
      const left = declarationLeft(node);
      if (left?.type !== 'value_declaration_left') return false; // function-shaped → functionTypes dispatch
      const name = valueBindingName(left, ctx.source);
      if (!name) return false;

      const parentId = ctx.nodeStack[ctx.nodeStack.length - 1];
      const parentKind = parentId ? ctx.nodes.find((n) => n.id === parentId)?.kind : undefined;
      const insideType =
        parentKind === 'class' || parentKind === 'struct' ||
        parentKind === 'interface' || parentKind === 'enum';
      let isMutable = false;
      for (let i = 0; i < left.childCount; i++) {
        if (left.child(i)?.type === 'mutable') { isMutable = true; break; }
      }
      const kind = insideType ? 'field' : isMutable ? 'variable' : 'constant';

      const created = ctx.createNode(kind, name, node, {
        signature: `let ${isMutable ? 'mutable ' : ''}${name}`,
        visibility: fsharpVisibility(node),
      });
      // Walk the initializer with the binding on the scope stack: module-level
      // values hold real flow in F# (Giraffe/Suave routing tables, partial
      // application) — their calls/pipe targets must attribute to the binding.
      if (created) {
        const body = getChildByField(node, 'body');
        if (body) {
          ctx.pushScope(created.id);
          ctx.visitFunctionBody(body, created.id);
          ctx.popScope();
        }
      }
      return true;
    }

    return false;
  },
};

/**
 * Function-first F# combinators: `List.map f xs` calls `f`. Used by the fsharp
 * branch of extractCall to lift the function argument into a `calls` edge —
 * the F# analog of Haskell's higher-order call synthesis. Data-first members
 * (e.g. `Option.defaultValue`) are deliberately absent.
 */
export const FSHARP_HOF_COMBINATORS: ReadonlySet<string> = new Set(
  ['List', 'Seq', 'Array', 'Option', 'Result', 'Map', 'Set', 'Async'].flatMap((m) => [
    'map', 'map2', 'mapi', 'iter', 'iter2', 'iteri', 'filter', 'choose', 'collect',
    'bind', 'exists', 'forall', 'find', 'tryFind', 'findIndex', 'tryFindIndex',
    'pick', 'tryPick', 'sortBy', 'sortByDescending', 'sortWith', 'groupBy',
    'minBy', 'maxBy', 'sumBy', 'averageBy', 'countBy', 'partition', 'takeWhile',
    'skipWhile', 'distinctBy', 'chunkBySize', 'fold', 'fold2', 'foldBack',
    'reduce', 'unfold', 'init',
  ].map((f) => `${m}.${f}`))
);

/** Bare F# core functions whose calls are noise (never user symbols). */
export const FSHARP_CALL_SKIP: ReadonlySet<string> = new Set([
  'printfn', 'printf', 'sprintf', 'eprintfn', 'eprintf', 'fprintfn', 'fprintf',
  'failwith', 'failwithf', 'invalidArg', 'invalidOp', 'nullArg', 'raise',
  'ignore', 'not', 'box', 'unbox', 'typeof', 'nameof', 'string', 'int', 'float',
  'bool', 'char', 'byte', 'decimal', 'int64', 'uint64', 'seq', 'async', 'task',
  'lock', 'defaultArg', 'id', 'fst', 'snd', 'incr', 'decr', 'ref', 'exit',
]);
