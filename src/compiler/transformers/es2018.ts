/*@internal*/
namespace ts {
    const enum ESNextSubstitutionFlags {
        /** Enables substitutions for async methods with `super` calls. */
        AsyncMethodsWithSuper = 1 << 0
    }

    export function transformES2018(context: TransformationContext) {
        const {
            factory,
            getEmitHelperFactory: emitHelpers,
            resumeLexicalEnvironment,
            endLexicalEnvironment,
            hoistVariableDeclaration
        } = context;

        const resolver = context.getEmitResolver();
        const compilerOptions = context.getCompilerOptions();
        const languageVersion = getEmitScriptTarget(compilerOptions);

        const previousOnEmitNode = context.onEmitNode;
        context.onEmitNode = onEmitNode;

        const previousOnSubstituteNode = context.onSubstituteNode;
        context.onSubstituteNode = onSubstituteNode;

        let exportedVariableStatement = false;
        let enabledSubstitutions: ESNextSubstitutionFlags;
        let enclosingFunctionFlags: FunctionFlags;
        let enclosingSuperContainerFlags: NodeCheckFlags = 0;
        let topLevel: boolean;

        /** Keeps track of property names accessed on super (`super.x`) within async functions. */
        let capturedSuperProperties: UnderscoreEscapedMap<true>;
        /** Whether the async function contains an element access on super (`super[x]`). */
        let hasSuperElementAccess: boolean;
        /** A set of node IDs for generated super accessors. */
        const substitutedSuperAccessors: boolean[] = [];

        return chainBundle(context, transformSourceFile);

        function transformSourceFile(node: SourceFile) {
            if (node.isDeclarationFile) {
                return node;
            }

            exportedVariableStatement = false;
            topLevel = isEffectiveStrictModeSourceFile(node, compilerOptions);
            const visited = visitEachChild(node, visitor, context);
            addEmitHelpers(visited, context.readEmitHelpers());
            return visited;
        }

        function visitor(node: Node): VisitResult<Node> {
            return visitorWorker(node, /*noDestructuringValue*/ false);
        }

        function visitorNoDestructuringValue(node: Node): VisitResult<Node> {
            return visitorWorker(node, /*noDestructuringValue*/ true);
        }

        function visitorNoAsyncModifier(node: Node): VisitResult<Node> {
            if (node.kind === SyntaxKind.AsyncKeyword) {
                return undefined;
            }
            return node;
        }

        function doOutsideOfTopLevel<T, U>(cb: (value: T) => U, value: T) {
            if (topLevel) {
                topLevel = false;
                const result = cb(value);
                topLevel = true;
                return result;
            }
            return cb(value);
        }

        function visitDefault(node: Node): VisitResult<Node> {
            return visitEachChild(node, visitor, context);
        }

        function visitorWorker(node: Node, noDestructuringValue: boolean): VisitResult<Node> {
            if ((node.transformFlags & TransformFlags.ContainsES2018) === 0) {
                return node;
            }
            switch (node.kind) {
                case SyntaxKind.AwaitExpression:
                    return visitAwaitExpression(node as AwaitExpression);
                case SyntaxKind.YieldExpression:
                    return visitYieldExpression(node as YieldExpression);
                case SyntaxKind.ReturnStatement:
                    return visitReturnStatement(node as ReturnStatement);
                case SyntaxKind.LabeledStatement:
                    return visitLabeledStatement(node as LabeledStatement);
                case SyntaxKind.ObjectLiteralExpression:
                    return visitObjectLiteralExpression(node as ObjectLiteralExpression);
                case SyntaxKind.BinaryExpression:
                    return visitBinaryExpression(node as BinaryExpression, noDestructuringValue);
                case SyntaxKind.CatchClause:
                    return visitCatchClause(node as CatchClause);
                case SyntaxKind.VariableStatement:
                    return visitVariableStatement(node as VariableStatement);
                case SyntaxKind.VariableDeclaration:
                    return visitVariableDeclaration(node as VariableDeclaration);
                case SyntaxKind.ForOfStatement:
                    return visitForOfStatement(node as ForOfStatement, /*outermostLabeledStatement*/ undefined);
                case SyntaxKind.ForStatement:
                    return visitForStatement(node as ForStatement);
                case SyntaxKind.VoidExpression:
                    return visitVoidExpression(node as VoidExpression);
                case SyntaxKind.Constructor:
                    return doOutsideOfTopLevel(visitConstructorDeclaration, node as ConstructorDeclaration);
                case SyntaxKind.MethodDeclaration:
                    return doOutsideOfTopLevel(visitMethodDeclaration, node as MethodDeclaration);
                case SyntaxKind.GetAccessor:
                    return doOutsideOfTopLevel(visitGetAccessorDeclaration, node as GetAccessorDeclaration);
                case SyntaxKind.SetAccessor:
                    return doOutsideOfTopLevel(visitSetAccessorDeclaration, node as SetAccessorDeclaration);
                case SyntaxKind.FunctionDeclaration:
                    return doOutsideOfTopLevel(visitFunctionDeclaration, node as FunctionDeclaration);
                case SyntaxKind.FunctionExpression:
                    return doOutsideOfTopLevel(visitFunctionExpression, node as FunctionExpression);
                case SyntaxKind.ArrowFunction:
                    return visitArrowFunction(node as ArrowFunction);
                case SyntaxKind.Parameter:
                    return visitParameter(node as ParameterDeclaration);
                case SyntaxKind.ExpressionStatement:
                    return visitExpressionStatement(node as ExpressionStatement);
                case SyntaxKind.ParenthesizedExpression:
                    return visitParenthesizedExpression(node as ParenthesizedExpression, noDestructuringValue);
                case SyntaxKind.PropertyAccessExpression:
                    if (capturedSuperProperties && isPropertyAccessExpression(node) && node.expression.kind === SyntaxKind.SuperKeyword) {
                        capturedSuperProperties.set(node.name.escapedText, true);
                    }
                    return visitEachChild(node, visitor, context);
                case SyntaxKind.ElementAccessExpression:
                    if (capturedSuperProperties && (<ElementAccessExpression>node).expression.kind === SyntaxKind.SuperKeyword) {
                        hasSuperElementAccess = true;
                    }
                    return visitEachChild(node, visitor, context);
                case SyntaxKind.ClassDeclaration:
                case SyntaxKind.ClassExpression:
                    return doOutsideOfTopLevel(visitDefault, node);
                default:
                    return visitEachChild(node, visitor, context);
            }
        }

        function visitAwaitExpression(node: AwaitExpression): Expression {
            if (enclosingFunctionFlags & FunctionFlags.Async && enclosingFunctionFlags & FunctionFlags.Generator) {
                return setOriginalNode(
                    setTextRange(
                        factory.createYield(/*asteriskToken*/ undefined, emitHelpers().createAwaitHelper(visitNode(node.expression, visitor, isExpression))),
                        /*location*/ node
                    ),
                    node
                );
            }
            return visitEachChild(node, visitor, context);
        }

        function visitYieldExpression(node: YieldExpression) {
            if (enclosingFunctionFlags & FunctionFlags.Async && enclosingFunctionFlags & FunctionFlags.Generator) {
                if (node.asteriskToken) {
                    const expression = visitNode(node.expression, visitor, isExpression);

                    return setOriginalNode(
                        setTextRange(
                            factory.createYield(
                                /*asteriskToken*/ undefined,
                                emitHelpers().createAwaitHelper(
                                    factory.updateYield(
                                        node,
                                        node.asteriskToken,
                                        setTextRange(
                                            emitHelpers().createAsyncDelegatorHelper(
                                                setTextRange(
                                                    emitHelpers().createAsyncValuesHelper(expression),
                                                    expression
                                                )
                                            ),
                                            expression
                                        )
                                    )
                                )
                            ),
                            node
                        ),
                        node
                    );
                }

                return setOriginalNode(
                    setTextRange(
                        factory.createYield(
                            /*asteriskToken*/ undefined,
                            createDownlevelAwait(
                                node.expression
                                    ? visitNode(node.expression, visitor, isExpression)
                                    : factory.createVoidZero()
                            )
                        ),
                        node
                    ),
                    node
                );
            }

            return visitEachChild(node, visitor, context);
        }

        function visitReturnStatement(node: ReturnStatement) {
            if (enclosingFunctionFlags & FunctionFlags.Async && enclosingFunctionFlags & FunctionFlags.Generator) {
                return factory.updateReturn(node, createDownlevelAwait(
                    node.expression ? visitNode(node.expression, visitor, isExpression) : factory.createVoidZero()
                ));
            }

            return visitEachChild(node, visitor, context);
        }

        function visitLabeledStatement(node: LabeledStatement) {
            if (enclosingFunctionFlags & FunctionFlags.Async) {
                const statement = unwrapInnermostStatementOfLabel(node);
                if (statement.kind === SyntaxKind.ForOfStatement && (<ForOfStatement>statement).awaitModifier) {
                    return visitForOfStatement(<ForOfStatement>statement, node);
                }
                return factory.restoreEnclosingLabel(visitEachChild(statement, visitor, context), node);
            }
            return visitEachChild(node, visitor, context);
        }

        function chunkObjectLiteralElements(elements: readonly ObjectLiteralElementLike[]): Expression[] {
            let chunkObject: ObjectLiteralElementLike[] | undefined;
            const objects: Expression[] = [];
            for (const e of elements) {
                if (e.kind === SyntaxKind.SpreadAssignment) {
                    if (chunkObject) {
                        objects.push(factory.createObjectLiteral(chunkObject));
                        chunkObject = undefined;
                    }
                    const target = e.expression;
                    objects.push(visitNode(target, visitor, isExpression));
                }
                else {
                    chunkObject = append(chunkObject, e.kind === SyntaxKind.PropertyAssignment
                        ? factory.createPropertyAssignment(e.name, visitNode(e.initializer, visitor, isExpression))
                        : visitNode(e, visitor, isObjectLiteralElementLike));
                }
            }
            if (chunkObject) {
                objects.push(factory.createObjectLiteral(chunkObject));
            }

            return objects;
        }

        function visitObjectLiteralExpression(node: ObjectLiteralExpression): Expression {
            if (node.transformFlags & TransformFlags.ContainsObjectRestOrSpread) {
                // spread elements emit like so:
                // non-spread elements are chunked together into object literals, and then all are passed to __assign:
                //     { a, ...o, b } => __assign(__assign({a}, o), {b});
                // If the first element is a spread element, then the first argument to __assign is {}:
                //     { ...o, a, b, ...o2 } => __assign(__assign(__assign({}, o), {a, b}), o2)
                //
                // We cannot call __assign with more than two elements, since any element could cause side effects. For
                // example:
                //      var k = { a: 1, b: 2 };
                //      var o = { a: 3, ...k, b: k.a++ };
                //      // expected: { a: 1, b: 1 }
                // If we translate the above to `__assign({ a: 3 }, k, { b: k.a++ })`, the `k.a++` will evaluate before
                // `k` is spread and we end up with `{ a: 2, b: 1 }`.
                //
                // This also occurs for spread elements, not just property assignments:
                //      var k = { a: 1, get b() { l = { z: 9 }; return 2; } };
                //      var l = { c: 3 };
                //      var o = { ...k, ...l };
                //      // expected: { a: 1, b: 2, z: 9 }
                // If we translate the above to `__assign({}, k, l)`, the `l` will evaluate before `k` is spread and we
                // end up with `{ a: 1, b: 2, c: 3 }`
                const objects = chunkObjectLiteralElements(node.properties);
                if (objects.length && objects[0].kind !== SyntaxKind.ObjectLiteralExpression) {
                    objects.unshift(factory.createObjectLiteral());
                }
                let expression: Expression = objects[0];
                if (objects.length > 1) {
                    for (let i = 1; i < objects.length; i++) {
                        expression = emitHelpers().createAssignHelper([expression, objects[i]]);
                    }
                    return expression;
                }
                else {
                    return emitHelpers().createAssignHelper(objects);
                }
            }
            return visitEachChild(node, visitor, context);
        }

        function visitExpressionStatement(node: ExpressionStatement): ExpressionStatement {
            return visitEachChild(node, visitorNoDestructuringValue, context);
        }

        function visitParenthesizedExpression(node: ParenthesizedExpression, noDestructuringValue: boolean): ParenthesizedExpression {
            return visitEachChild(node, noDestructuringValue ? visitorNoDestructuringValue : visitor, context);
        }

        /**
         * Visits a BinaryExpression that contains a destructuring assignment.
         *
         * @param node A BinaryExpression node.
         */
        function visitBinaryExpression(node: BinaryExpression, noDestructuringValue: boolean): Expression {
            if (isDestructuringAssignment(node) && node.left.transformFlags & TransformFlags.ContainsObjectRestOrSpread) {
                return flattenDestructuringAssignment(
                    node,
                    visitor,
                    context,
                    FlattenLevel.ObjectRest,
                    !noDestructuringValue
                );
            }
            else if (node.operatorToken.kind === SyntaxKind.CommaToken) {
                return factory.updateBinary(
                    node,
                    visitNode(node.left, visitorNoDestructuringValue, isExpression),
                    visitNode(node.right, noDestructuringValue ? visitorNoDestructuringValue : visitor, isExpression)
                );
            }
            return visitEachChild(node, visitor, context);
        }

        function visitCatchClause(node: CatchClause) {
            if (node.variableDeclaration &&
                isBindingPattern(node.variableDeclaration.name) &&
                node.variableDeclaration.name.transformFlags & TransformFlags.ContainsObjectRestOrSpread) {
                const name = factory.getGeneratedNameForNode(node.variableDeclaration.name);
                const updatedDecl = factory.updateVariableDeclaration(node.variableDeclaration, node.variableDeclaration.name, /*exclamationToken*/ undefined, /*type*/ undefined, name);
                const visitedBindings = flattenDestructuringBinding(updatedDecl, visitor, context, FlattenLevel.ObjectRest);
                let block = visitNode(node.block, visitor, isBlock);
                if (some(visitedBindings)) {
                    block = factory.updateBlock(block, [
                        factory.createVariableStatement(/*modifiers*/ undefined, visitedBindings),
                        ...block.statements,
                    ]);
                }
                return factory.updateCatchClause(
                    node,
                    factory.updateVariableDeclaration(node.variableDeclaration, name, /*exclamationToken*/ undefined, /*type*/ undefined, /*initializer*/ undefined),
                    block);
            }
            return visitEachChild(node, visitor, context);
        }

        function visitVariableStatement(node: VariableStatement): VisitResult<VariableStatement> {
            if (hasModifier(node, ModifierFlags.Export)) {
                const savedExportedVariableStatement = exportedVariableStatement;
                exportedVariableStatement = true;
                const visited = visitEachChild(node, visitor, context);
                exportedVariableStatement = savedExportedVariableStatement;
                return visited;
            }
            return visitEachChild(node, visitor, context);
        }

        /**
         * Visits a VariableDeclaration node with a binding pattern.
         *
         * @param node A VariableDeclaration node.
         */
        function visitVariableDeclaration(node: VariableDeclaration): VisitResult<VariableDeclaration> {
            if (exportedVariableStatement) {
                const savedExportedVariableStatement = exportedVariableStatement;
                exportedVariableStatement = false;
                const visited = visitVariableDeclarationWorker(node, /*exportedVariableStatement*/ true);
                exportedVariableStatement = savedExportedVariableStatement;
                return visited;
            }
            return visitVariableDeclarationWorker(node, /*exportedVariableStatement*/ false);
        }

        function visitVariableDeclarationWorker(node: VariableDeclaration, exportedVariableStatement: boolean): VisitResult<VariableDeclaration> {
            // If we are here it is because the name contains a binding pattern with a rest somewhere in it.
            if (isBindingPattern(node.name) && node.name.transformFlags & TransformFlags.ContainsObjectRestOrSpread) {
                return flattenDestructuringBinding(
                    node,
                    visitor,
                    context,
                    FlattenLevel.ObjectRest,
                    /*rval*/ undefined,
                    exportedVariableStatement
                );
            }
            return visitEachChild(node, visitor, context);
        }

        function visitForStatement(node: ForStatement): VisitResult<Statement> {
            return factory.updateFor(
                node,
                visitNode(node.initializer, visitorNoDestructuringValue, isForInitializer),
                visitNode(node.condition, visitor, isExpression),
                visitNode(node.incrementor, visitor, isExpression),
                visitNode(node.statement, visitor, isStatement)
            );
        }

        function visitVoidExpression(node: VoidExpression) {
            return visitEachChild(node, visitorNoDestructuringValue, context);
        }

        /**
         * Visits a ForOfStatement and converts it into a ES2015-compatible ForOfStatement.
         *
         * @param node A ForOfStatement.
         */
        function visitForOfStatement(node: ForOfStatement, outermostLabeledStatement: LabeledStatement | undefined): VisitResult<Statement> {
            if (node.initializer.transformFlags & TransformFlags.ContainsObjectRestOrSpread) {
                node = transformForOfStatementWithObjectRest(node);
            }
            if (node.awaitModifier) {
                return transformForAwaitOfStatement(node, outermostLabeledStatement);
            }
            else {
                return factory.restoreEnclosingLabel(visitEachChild(node, visitor, context), outermostLabeledStatement);
            }
        }

        function transformForOfStatementWithObjectRest(node: ForOfStatement) {
            const initializerWithoutParens = skipParentheses(node.initializer) as ForInitializer;
            if (isVariableDeclarationList(initializerWithoutParens) || isAssignmentPattern(initializerWithoutParens)) {
                let bodyLocation: TextRange | undefined;
                let statementsLocation: TextRange | undefined;
                const temp = factory.createTempVariable(/*recordTempVariable*/ undefined);
                const statements: Statement[] = [createForOfBindingStatement(factory, initializerWithoutParens, temp)];
                if (isBlock(node.statement)) {
                    addRange(statements, node.statement.statements);
                    bodyLocation = node.statement;
                    statementsLocation = node.statement.statements;
                }
                else if (node.statement) {
                    append(statements, node.statement);
                    bodyLocation = node.statement;
                    statementsLocation = node.statement;
                }
                return factory.updateForOf(
                    node,
                    node.awaitModifier,
                    setTextRange(
                        factory.createVariableDeclarationList(
                            [
                                setTextRange(factory.createVariableDeclaration(temp), node.initializer)
                            ],
                            NodeFlags.Let
                        ),
                        node.initializer
                    ),
                    node.expression,
                    setTextRange(
                        factory.createBlock(
                            setTextRange(factory.createNodeArray(statements), statementsLocation),
                            /*multiLine*/ true
                        ),
                        bodyLocation
                    )
                );
            }
            return node;
        }

        function convertForOfStatementHead(node: ForOfStatement, boundValue: Expression) {
            const binding = createForOfBindingStatement(factory, node.initializer, boundValue);

            let bodyLocation: TextRange | undefined;
            let statementsLocation: TextRange | undefined;
            const statements: Statement[] = [visitNode(binding, visitor, isStatement)];
            const statement = visitNode(node.statement, visitor, isStatement);
            if (isBlock(statement)) {
                addRange(statements, statement.statements);
                bodyLocation = statement;
                statementsLocation = statement.statements;
            }
            else {
                statements.push(statement);
            }

            return setEmitFlags(
                setTextRange(
                    factory.createBlock(
                        setTextRange(factory.createNodeArray(statements), statementsLocation),
                        /*multiLine*/ true
                    ),
                    bodyLocation
                ),
                EmitFlags.NoSourceMap | EmitFlags.NoTokenSourceMaps
            );
        }

        function createDownlevelAwait(expression: Expression) {
            return enclosingFunctionFlags & FunctionFlags.Generator
                ? factory.createYield(/*asteriskToken*/ undefined, emitHelpers().createAwaitHelper(expression))
                : factory.createAwait(expression);
        }

        function transformForAwaitOfStatement(node: ForOfStatement, outermostLabeledStatement: LabeledStatement | undefined) {
            const expression = visitNode(node.expression, visitor, isExpression);
            const iterator = isIdentifier(expression) ? factory.getGeneratedNameForNode(expression) : factory.createTempVariable(/*recordTempVariable*/ undefined);
            const result = isIdentifier(expression) ? factory.getGeneratedNameForNode(iterator) : factory.createTempVariable(/*recordTempVariable*/ undefined);
            const errorRecord = factory.createUniqueName("e");
            const catchVariable = factory.getGeneratedNameForNode(errorRecord);
            const returnMethod = factory.createTempVariable(/*recordTempVariable*/ undefined);
            const callValues = setTextRange(emitHelpers().createAsyncValuesHelper(expression), node.expression);
            const callNext = factory.createCall(factory.createPropertyAccess(iterator, "next"), /*typeArguments*/ undefined, []);
            const getDone = factory.createPropertyAccess(result, "done");
            const getValue = factory.createPropertyAccess(result, "value");
            const callReturn = factory.createFunctionCallCall(returnMethod, iterator, []);

            hoistVariableDeclaration(errorRecord);
            hoistVariableDeclaration(returnMethod);

            const forStatement = setEmitFlags(
                setTextRange(
                    factory.createFor(
                        /*initializer*/ setEmitFlags(
                            setTextRange(
                                factory.createVariableDeclarationList([
                                    setTextRange(factory.createVariableDeclaration(iterator, /*exclamationToken*/ undefined, /*type*/ undefined, callValues), node.expression),
                                    factory.createVariableDeclaration(result)
                                ]),
                                node.expression
                            ),
                            EmitFlags.NoHoisting
                        ),
                        /*condition*/ factory.createComma(
                            factory.createAssignment(result, createDownlevelAwait(callNext)),
                            factory.createLogicalNot(getDone)
                        ),
                        /*incrementor*/ undefined,
                        /*statement*/ convertForOfStatementHead(node, getValue)
                    ),
                    /*location*/ node
                ),
                EmitFlags.NoTokenTrailingSourceMaps
            );

            return factory.createTry(
                factory.createBlock([
                    factory.restoreEnclosingLabel(
                        forStatement,
                        outermostLabeledStatement
                    )
                ]),
                factory.createCatchClause(
                    factory.createVariableDeclaration(catchVariable),
                    setEmitFlags(
                        factory.createBlock([
                            factory.createExpressionStatement(
                                factory.createAssignment(
                                    errorRecord,
                                    factory.createObjectLiteral([
                                        factory.createPropertyAssignment("error", catchVariable)
                                    ])
                                )
                            )
                        ]),
                        EmitFlags.SingleLine
                    )
                ),
                factory.createBlock([
                    factory.createTry(
                        /*tryBlock*/ factory.createBlock([
                            setEmitFlags(
                                factory.createIf(
                                    factory.createLogicalAnd(
                                        factory.createLogicalAnd(
                                            result,
                                            factory.createLogicalNot(getDone)
                                        ),
                                        factory.createAssignment(
                                            returnMethod,
                                            factory.createPropertyAccess(iterator, "return")
                                        )
                                    ),
                                    factory.createExpressionStatement(createDownlevelAwait(callReturn))
                                ),
                                EmitFlags.SingleLine
                            )
                        ]),
                        /*catchClause*/ undefined,
                        /*finallyBlock*/ setEmitFlags(
                            factory.createBlock([
                                setEmitFlags(
                                    factory.createIf(
                                        errorRecord,
                                        factory.createThrow(
                                            factory.createPropertyAccess(errorRecord, "error")
                                        )
                                    ),
                                    EmitFlags.SingleLine
                                )
                            ]),
                            EmitFlags.SingleLine
                        )
                    )
                ])
            );
        }

        function visitParameter(node: ParameterDeclaration): ParameterDeclaration {
            if (node.transformFlags & TransformFlags.ContainsObjectRestOrSpread) {
                // Binding patterns are converted into a generated name and are
                // evaluated inside the function body.
                return factory.updateParameterDeclaration(
                    node,
                    /*decorators*/ undefined,
                    /*modifiers*/ undefined,
                    node.dotDotDotToken,
                    factory.getGeneratedNameForNode(node),
                    /*questionToken*/ undefined,
                    /*type*/ undefined,
                    visitNode(node.initializer, visitor, isExpression)
                );
            }
            return visitEachChild(node, visitor, context);
        }

        function visitConstructorDeclaration(node: ConstructorDeclaration) {
            const savedEnclosingFunctionFlags = enclosingFunctionFlags;
            enclosingFunctionFlags = FunctionFlags.Normal;
            const updated = factory.updateConstructorDeclaration(
                node,
                /*decorators*/ undefined,
                node.modifiers,
                visitParameterList(node.parameters, visitor, context),
                transformFunctionBody(node)
            );
            enclosingFunctionFlags = savedEnclosingFunctionFlags;
            return updated;
        }

        function visitGetAccessorDeclaration(node: GetAccessorDeclaration) {
            const savedEnclosingFunctionFlags = enclosingFunctionFlags;
            enclosingFunctionFlags = FunctionFlags.Normal;
            const updated = factory.updateGetAccessorDeclaration(
                node,
                /*decorators*/ undefined,
                node.modifiers,
                visitNode(node.name, visitor, isPropertyName),
                visitParameterList(node.parameters, visitor, context),
                /*type*/ undefined,
                transformFunctionBody(node)
            );
            enclosingFunctionFlags = savedEnclosingFunctionFlags;
            return updated;
        }

        function visitSetAccessorDeclaration(node: SetAccessorDeclaration) {
            const savedEnclosingFunctionFlags = enclosingFunctionFlags;
            enclosingFunctionFlags = FunctionFlags.Normal;
            const updated = factory.updateSetAccessorDeclaration(
                node,
                /*decorators*/ undefined,
                node.modifiers,
                visitNode(node.name, visitor, isPropertyName),
                visitParameterList(node.parameters, visitor, context),
                transformFunctionBody(node)
            );
            enclosingFunctionFlags = savedEnclosingFunctionFlags;
            return updated;
        }

        function visitMethodDeclaration(node: MethodDeclaration) {
            const savedEnclosingFunctionFlags = enclosingFunctionFlags;
            enclosingFunctionFlags = getFunctionFlags(node);
            const updated = factory.updateMethodDeclaration(
                node,
                /*decorators*/ undefined,
                enclosingFunctionFlags & FunctionFlags.Generator
                    ? visitNodes(node.modifiers, visitorNoAsyncModifier, isModifier)
                    : node.modifiers,
                enclosingFunctionFlags & FunctionFlags.Async
                    ? undefined
                    : node.asteriskToken,
                visitNode(node.name, visitor, isPropertyName),
                visitNode<Token<SyntaxKind.QuestionToken>>(/*questionToken*/ undefined, visitor, isToken),
                /*typeParameters*/ undefined,
                visitParameterList(node.parameters, visitor, context),
                /*type*/ undefined,
                enclosingFunctionFlags & FunctionFlags.Async && enclosingFunctionFlags & FunctionFlags.Generator
                    ? transformAsyncGeneratorFunctionBody(node)
                    : transformFunctionBody(node)
            );
            enclosingFunctionFlags = savedEnclosingFunctionFlags;
            return updated;
        }

        function visitFunctionDeclaration(node: FunctionDeclaration) {
            const savedEnclosingFunctionFlags = enclosingFunctionFlags;
            enclosingFunctionFlags = getFunctionFlags(node);
            const updated = factory.updateFunctionDeclaration(
                node,
                /*decorators*/ undefined,
                enclosingFunctionFlags & FunctionFlags.Generator
                    ? visitNodes(node.modifiers, visitorNoAsyncModifier, isModifier)
                    : node.modifiers,
                enclosingFunctionFlags & FunctionFlags.Async
                    ? undefined
                    : node.asteriskToken,
                node.name,
                /*typeParameters*/ undefined,
                visitParameterList(node.parameters, visitor, context),
                /*type*/ undefined,
                enclosingFunctionFlags & FunctionFlags.Async && enclosingFunctionFlags & FunctionFlags.Generator
                    ? transformAsyncGeneratorFunctionBody(node)
                    : transformFunctionBody(node)
            );
            enclosingFunctionFlags = savedEnclosingFunctionFlags;
            return updated;
        }

        function visitArrowFunction(node: ArrowFunction) {
            const savedEnclosingFunctionFlags = enclosingFunctionFlags;
            enclosingFunctionFlags = getFunctionFlags(node);
            const updated = factory.updateArrowFunction(
                node,
                node.modifiers,
                /*typeParameters*/ undefined,
                visitParameterList(node.parameters, visitor, context),
                /*type*/ undefined,
                node.equalsGreaterThanToken,
                transformFunctionBody(node),
            );
            enclosingFunctionFlags = savedEnclosingFunctionFlags;
            return updated;
        }

        function visitFunctionExpression(node: FunctionExpression) {
            const savedEnclosingFunctionFlags = enclosingFunctionFlags;
            enclosingFunctionFlags = getFunctionFlags(node);
            const updated = factory.updateFunctionExpression(
                node,
                enclosingFunctionFlags & FunctionFlags.Generator
                    ? visitNodes(node.modifiers, visitorNoAsyncModifier, isModifier)
                    : node.modifiers,
                enclosingFunctionFlags & FunctionFlags.Async
                    ? undefined
                    : node.asteriskToken,
                node.name,
                /*typeParameters*/ undefined,
                visitParameterList(node.parameters, visitor, context),
                /*type*/ undefined,
                enclosingFunctionFlags & FunctionFlags.Async && enclosingFunctionFlags & FunctionFlags.Generator
                    ? transformAsyncGeneratorFunctionBody(node)
                    : transformFunctionBody(node)
            );
            enclosingFunctionFlags = savedEnclosingFunctionFlags;
            return updated;
        }

        function transformAsyncGeneratorFunctionBody(node: MethodDeclaration | AccessorDeclaration | FunctionDeclaration | FunctionExpression): FunctionBody {
            resumeLexicalEnvironment();
            const statements: Statement[] = [];
            const statementOffset = factory.copyPrologue(node.body!.statements, statements, /*ensureUseStrict*/ false, visitor);
            appendObjectRestAssignmentsIfNeeded(statements, node);

            const savedCapturedSuperProperties = capturedSuperProperties;
            const savedHasSuperElementAccess = hasSuperElementAccess;
            capturedSuperProperties = createUnderscoreEscapedMap<true>();
            hasSuperElementAccess = false;

            const returnStatement = factory.createReturn(
                emitHelpers().createAsyncGeneratorHelper(
                    factory.createFunctionExpression(
                        /*modifiers*/ undefined,
                        factory.createToken(SyntaxKind.AsteriskToken),
                        node.name && factory.getGeneratedNameForNode(node.name),
                        /*typeParameters*/ undefined,
                        /*parameters*/ [],
                        /*type*/ undefined,
                        factory.updateBlock(
                            node.body!,
                            visitLexicalEnvironment(node.body!.statements, visitor, context, statementOffset)
                        )
                    ),
                    !topLevel
                )
            );

            // Minor optimization, emit `_super` helper to capture `super` access in an arrow.
            // This step isn't needed if we eventually transform this to ES5.
            const emitSuperHelpers = languageVersion >= ScriptTarget.ES2015 && resolver.getNodeCheckFlags(node) & (NodeCheckFlags.AsyncMethodWithSuperBinding | NodeCheckFlags.AsyncMethodWithSuper);

            if (emitSuperHelpers) {
                enableSubstitutionForAsyncMethodsWithSuper();
                const variableStatement = createSuperAccessVariableStatement(factory, resolver, node, capturedSuperProperties);
                substitutedSuperAccessors[getNodeId(variableStatement)] = true;
                insertStatementsAfterStandardPrologue(statements, [variableStatement]);
            }

            statements.push(returnStatement);

            insertStatementsAfterStandardPrologue(statements, endLexicalEnvironment());
            const block = factory.updateBlock(node.body!, statements);

            if (emitSuperHelpers && hasSuperElementAccess) {
                if (resolver.getNodeCheckFlags(node) & NodeCheckFlags.AsyncMethodWithSuperBinding) {
                    addEmitHelper(block, advancedAsyncSuperHelper);
                }
                else if (resolver.getNodeCheckFlags(node) & NodeCheckFlags.AsyncMethodWithSuper) {
                    addEmitHelper(block, asyncSuperHelper);
                }
            }

            capturedSuperProperties = savedCapturedSuperProperties;
            hasSuperElementAccess = savedHasSuperElementAccess;

            return block;
        }

        function transformFunctionBody(node: FunctionDeclaration | FunctionExpression | ConstructorDeclaration | MethodDeclaration | AccessorDeclaration): FunctionBody;
        function transformFunctionBody(node: ArrowFunction): ConciseBody;
        function transformFunctionBody(node: FunctionLikeDeclaration): ConciseBody {
            resumeLexicalEnvironment();
            let statementOffset = 0;
            const statements: Statement[] = [];
            const body = visitNode(node.body, visitor, isConciseBody);
            if (isBlock(body)) {
                statementOffset = factory.copyPrologue(body.statements, statements, /*ensureUseStrict*/ false, visitor);
            }
            addRange(statements, appendObjectRestAssignmentsIfNeeded(/*statements*/ undefined, node));
            const leadingStatements = endLexicalEnvironment();
            if (statementOffset > 0 || some(statements) || some(leadingStatements)) {
                const block = factory.converters.convertToFunctionBlock(body, /*multiLine*/ true);
                insertStatementsAfterStandardPrologue(statements, leadingStatements);
                addRange(statements, block.statements.slice(statementOffset));
                return factory.updateBlock(block, setTextRange(factory.createNodeArray(statements), block.statements));
            }
            return body;
        }

        function appendObjectRestAssignmentsIfNeeded(statements: Statement[] | undefined, node: FunctionLikeDeclaration): Statement[] | undefined {
            for (const parameter of node.parameters) {
                if (parameter.transformFlags & TransformFlags.ContainsObjectRestOrSpread) {
                    const temp = factory.getGeneratedNameForNode(parameter);
                    const declarations = flattenDestructuringBinding(
                        parameter,
                        visitor,
                        context,
                        FlattenLevel.ObjectRest,
                        temp,
                        /*doNotRecordTempVariablesInLine*/ false,
                        /*skipInitializer*/ true,
                    );
                    if (some(declarations)) {
                        const statement = factory.createVariableStatement(
                            /*modifiers*/ undefined,
                            factory.createVariableDeclarationList(
                                declarations
                            )
                        );
                        setEmitFlags(statement, EmitFlags.CustomPrologue);
                        statements = append(statements, statement);
                    }
                }
            }
            return statements;
        }

        function enableSubstitutionForAsyncMethodsWithSuper() {
            if ((enabledSubstitutions & ESNextSubstitutionFlags.AsyncMethodsWithSuper) === 0) {
                enabledSubstitutions |= ESNextSubstitutionFlags.AsyncMethodsWithSuper;

                // We need to enable substitutions for call, property access, and element access
                // if we need to rewrite super calls.
                context.enableSubstitution(SyntaxKind.CallExpression);
                context.enableSubstitution(SyntaxKind.PropertyAccessExpression);
                context.enableSubstitution(SyntaxKind.ElementAccessExpression);

                // We need to be notified when entering and exiting declarations that bind super.
                context.enableEmitNotification(SyntaxKind.ClassDeclaration);
                context.enableEmitNotification(SyntaxKind.MethodDeclaration);
                context.enableEmitNotification(SyntaxKind.GetAccessor);
                context.enableEmitNotification(SyntaxKind.SetAccessor);
                context.enableEmitNotification(SyntaxKind.Constructor);
                // We need to be notified when entering the generated accessor arrow functions.
                context.enableEmitNotification(SyntaxKind.VariableStatement);
            }
        }

        /**
         * Called by the printer just before a node is printed.
         *
         * @param hint A hint as to the intended usage of the node.
         * @param node The node to be printed.
         * @param emitCallback The callback used to emit the node.
         */
        function onEmitNode(hint: EmitHint, node: Node, emitCallback: (hint: EmitHint, node: Node) => void) {
            // If we need to support substitutions for `super` in an async method,
            // we should track it here.
            if (enabledSubstitutions & ESNextSubstitutionFlags.AsyncMethodsWithSuper && isSuperContainer(node)) {
                const superContainerFlags = resolver.getNodeCheckFlags(node) & (NodeCheckFlags.AsyncMethodWithSuper | NodeCheckFlags.AsyncMethodWithSuperBinding);
                if (superContainerFlags !== enclosingSuperContainerFlags) {
                    const savedEnclosingSuperContainerFlags = enclosingSuperContainerFlags;
                    enclosingSuperContainerFlags = superContainerFlags;
                    previousOnEmitNode(hint, node, emitCallback);
                    enclosingSuperContainerFlags = savedEnclosingSuperContainerFlags;
                    return;
                }
            }
            // Disable substitution in the generated super accessor itself.
            else if (enabledSubstitutions && substitutedSuperAccessors[getNodeId(node)]) {
                const savedEnclosingSuperContainerFlags = enclosingSuperContainerFlags;
                enclosingSuperContainerFlags = 0 as NodeCheckFlags;
                previousOnEmitNode(hint, node, emitCallback);
                enclosingSuperContainerFlags = savedEnclosingSuperContainerFlags;
                return;
            }

            previousOnEmitNode(hint, node, emitCallback);
        }

        /**
         * Hooks node substitutions.
         *
         * @param hint The context for the emitter.
         * @param node The node to substitute.
         */
        function onSubstituteNode(hint: EmitHint, node: Node) {
            node = previousOnSubstituteNode(hint, node);
            if (hint === EmitHint.Expression && enclosingSuperContainerFlags) {
                return substituteExpression(<Expression>node);
            }
            return node;
        }

        function substituteExpression(node: Expression) {
            switch (node.kind) {
                case SyntaxKind.PropertyAccessExpression:
                    return substitutePropertyAccessExpression(<PropertyAccessExpression>node);
                case SyntaxKind.ElementAccessExpression:
                    return substituteElementAccessExpression(<ElementAccessExpression>node);
                case SyntaxKind.CallExpression:
                    return substituteCallExpression(<CallExpression>node);
            }
            return node;
        }

        function substitutePropertyAccessExpression(node: PropertyAccessExpression) {
            if (node.expression.kind === SyntaxKind.SuperKeyword) {
                return setTextRange(
                    factory.createPropertyAccess(
                        factory.createFileLevelUniqueName("_super"),
                        node.name),
                    node
                );
            }
            return node;
        }

        function substituteElementAccessExpression(node: ElementAccessExpression) {
            if (node.expression.kind === SyntaxKind.SuperKeyword) {
                return createSuperElementAccessInAsyncMethod(
                    node.argumentExpression,
                    node
                );
            }
            return node;
        }

        function substituteCallExpression(node: CallExpression): Expression {
            const expression = node.expression;
            if (isSuperProperty(expression)) {
                const argumentExpression = isPropertyAccessExpression(expression)
                    ? substitutePropertyAccessExpression(expression)
                    : substituteElementAccessExpression(expression);
                return factory.createCall(
                    factory.createPropertyAccess(argumentExpression, "call"),
                    /*typeArguments*/ undefined,
                    [
                        factory.createThis(),
                        ...node.arguments
                    ]
                );
            }
            return node;
        }

        function isSuperContainer(node: Node) {
            const kind = node.kind;
            return kind === SyntaxKind.ClassDeclaration
                || kind === SyntaxKind.Constructor
                || kind === SyntaxKind.MethodDeclaration
                || kind === SyntaxKind.GetAccessor
                || kind === SyntaxKind.SetAccessor;
        }

        function createSuperElementAccessInAsyncMethod(argumentExpression: Expression, location: TextRange): LeftHandSideExpression {
            if (enclosingSuperContainerFlags & NodeCheckFlags.AsyncMethodWithSuperBinding) {
                return setTextRange(
                    factory.createPropertyAccess(
                        factory.createCall(
                            factory.createIdentifier("_superIndex"),
                            /*typeArguments*/ undefined,
                            [argumentExpression]
                        ),
                        "value"
                    ),
                    location
                );
            }
            else {
                return setTextRange(
                    factory.createCall(
                        factory.createIdentifier("_superIndex"),
                        /*typeArguments*/ undefined,
                        [argumentExpression]
                    ),
                    location
                );
            }
        }
    }
}
