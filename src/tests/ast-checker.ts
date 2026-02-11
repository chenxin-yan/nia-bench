import { Node, Project, type SourceFile, SyntaxKind } from "ts-morph";
import type { AstCheck } from "@/types/task";

// --- Result Type ---

export interface AstCheckResult {
	check: AstCheck;
	passed: boolean;
	message: string;
}

// --- Main Entry Point ---

/**
 * Parses code with ts-morph and runs each AST check against it.
 * Creates an in-memory source file (no disk I/O).
 */
export function runAstChecks(
	code: string,
	checks: AstCheck[],
): AstCheckResult[] {
	const project = new Project({ useInMemoryFileSystem: true });

	let sourceFile: SourceFile;
	try {
		sourceFile = project.createSourceFile("temp.tsx", code);
	} catch (err) {
		// If code is completely unparseable, fail all checks
		const message =
			err instanceof Error
				? `Failed to parse code: ${err.message}`
				: "Failed to parse code";
		return checks.map((check) => ({ check, passed: false, message }));
	}

	return checks.map((check) => runSingleCheck(sourceFile, check));
}

// --- Individual Check Implementations ---

function runSingleCheck(
	sourceFile: SourceFile,
	check: AstCheck,
): AstCheckResult {
	try {
		switch (check.type) {
			case "import_exists":
				return checkImportExists(sourceFile, check);
			case "import_absent":
				return checkImportAbsent(sourceFile, check);
			case "module_import_absent":
				return checkModuleImportAbsent(sourceFile, check);
			case "function_exported":
				return checkFunctionExported(sourceFile, check);
			case "function_absent":
				return checkFunctionAbsent(sourceFile, check);
			case "await_present":
				return checkAwaitPresent(sourceFile, check);
			case "await_absent":
				return checkAwaitAbsent(sourceFile, check);
			case "call_exists":
				return checkCallExists(sourceFile, check);
			case "call_absent":
				return checkCallAbsent(sourceFile, check);
			case "directive_present":
				return checkDirectivePresent(sourceFile, check);
			case "property_location":
				return checkPropertyLocation(sourceFile, check);
			case "async_function":
				return checkAsyncFunction(sourceFile, check);
			case "async_generator":
				return checkAsyncGenerator(sourceFile, check);
			case "yield_present":
				return checkYieldPresent(sourceFile, check);
			case "type_annotation":
				return checkTypeAnnotation(sourceFile, check);
			case "property_absent":
				return checkPropertyAbsent(sourceFile, check);
			default: {
				const _exhaustive: never = check;
				return {
					check: _exhaustive,
					passed: false,
					message: "Unknown check type",
				};
			}
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return {
			check,
			passed: false,
			message: `Check threw an error: ${message}`,
		};
	}
}

// --- import_exists ---
// Verify a specific named import from a specific module exists
function checkImportExists(
	sourceFile: SourceFile,
	check: Extract<AstCheck, { type: "import_exists" }>,
): AstCheckResult {
	const imports = sourceFile.getImportDeclarations();
	for (const imp of imports) {
		const moduleSpecifier = imp.getModuleSpecifierValue();
		if (moduleSpecifier !== check.from) continue;

		// Check named imports
		const namedImports = imp.getNamedImports();
		for (const named of namedImports) {
			if (named.getName() === check.name) {
				return {
					check,
					passed: true,
					message: `Found import { ${check.name} } from '${check.from}'`,
				};
			}
		}

		// Check default import
		const defaultImport = imp.getDefaultImport();
		if (defaultImport?.getText() === check.name) {
			return {
				check,
				passed: true,
				message: `Found default import ${check.name} from '${check.from}'`,
			};
		}

		// Check namespace import
		const namespaceImport = imp.getNamespaceImport();
		if (namespaceImport?.getText() === check.name) {
			return {
				check,
				passed: true,
				message: `Found namespace import * as ${check.name} from '${check.from}'`,
			};
		}
	}

	return {
		check,
		passed: false,
		message: `Import { ${check.name} } from '${check.from}' not found`,
	};
}

// --- import_absent ---
// Verify a specific named import does NOT exist (from any module, or from a specific module)
function checkImportAbsent(
	sourceFile: SourceFile,
	check: Extract<AstCheck, { type: "import_absent" }>,
): AstCheckResult {
	const imports = sourceFile.getImportDeclarations();
	for (const imp of imports) {
		// If `from` is specified, only check that specific module
		if (check.from && imp.getModuleSpecifierValue() !== check.from) continue;

		const namedImports = imp.getNamedImports();
		for (const named of namedImports) {
			if (named.getName() === check.name) {
				const from = imp.getModuleSpecifierValue();
				return {
					check,
					passed: false,
					message: `Found unwanted import { ${check.name} } from '${from}'`,
				};
			}
		}

		const defaultImport = imp.getDefaultImport();
		if (defaultImport?.getText() === check.name) {
			const from = imp.getModuleSpecifierValue();
			return {
				check,
				passed: false,
				message: `Found unwanted default import ${check.name} from '${from}'`,
			};
		}
	}

	const fromClause = check.from ? ` from '${check.from}'` : "";
	return {
		check,
		passed: true,
		message: `Import '${check.name}'${fromClause} is correctly absent`,
	};
}

// --- module_import_absent ---
// Verify no imports from a specific module
function checkModuleImportAbsent(
	sourceFile: SourceFile,
	check: Extract<AstCheck, { type: "module_import_absent" }>,
): AstCheckResult {
	const imports = sourceFile.getImportDeclarations();
	for (const imp of imports) {
		if (imp.getModuleSpecifierValue() === check.module) {
			return {
				check,
				passed: false,
				message: `Found unwanted import from '${check.module}'`,
			};
		}
	}

	return {
		check,
		passed: true,
		message: `No imports from '${check.module}' — correctly absent`,
	};
}

// --- function_exported ---
// Verify a named function is exported
function checkFunctionExported(
	sourceFile: SourceFile,
	check: Extract<AstCheck, { type: "function_exported" }>,
): AstCheckResult {
	// Check exported declarations
	const exportedDeclarations = sourceFile.getExportedDeclarations();

	for (const [name, declarations] of exportedDeclarations) {
		if (name === check.name) {
			// Verify at least one declaration is a function
			for (const decl of declarations) {
				if (
					Node.isFunctionDeclaration(decl) ||
					Node.isVariableDeclaration(decl)
				) {
					return {
						check,
						passed: true,
						message: `Found exported function '${check.name}'`,
					};
				}
			}
			// It's exported but not as a function — still count it as exported
			return {
				check,
				passed: true,
				message: `Found exported declaration '${check.name}'`,
			};
		}
	}

	return {
		check,
		passed: false,
		message: `No exported function '${check.name}' found`,
	};
}

// --- function_absent ---
// Verify a named function is NOT exported
function checkFunctionAbsent(
	sourceFile: SourceFile,
	check: Extract<AstCheck, { type: "function_absent" }>,
): AstCheckResult {
	const exportedDeclarations = sourceFile.getExportedDeclarations();

	for (const [name] of exportedDeclarations) {
		if (name === check.name) {
			return {
				check,
				passed: false,
				message: `Found unwanted exported function '${check.name}'`,
			};
		}
	}

	return {
		check,
		passed: true,
		message: `Function '${check.name}' is correctly absent from exports`,
	};
}

// --- await_present ---
// Verify a specific function call IS awaited
function checkAwaitPresent(
	sourceFile: SourceFile,
	check: Extract<AstCheck, { type: "await_present" }>,
): AstCheckResult {
	const awaitExpressions = sourceFile.getDescendantsOfKind(
		SyntaxKind.AwaitExpression,
	);

	for (const awaitExpr of awaitExpressions) {
		const expression = awaitExpr.getExpression();
		const exprText = expression.getText();
		if (matchesCallPattern(exprText, check.call)) {
			return {
				check,
				passed: true,
				message: `Found 'await ${check.call}' pattern`,
			};
		}
		// Also check the callee of CallExpressions (e.g., `await foo({...})` should match pattern `foo`)
		if (Node.isCallExpression(expression)) {
			const calleeText = expression.getExpression().getText();
			if (matchesCallPattern(calleeText, check.call)) {
				return {
					check,
					passed: true,
					message: `Found 'await ${check.call}(...)' pattern`,
				};
			}
		}
	}

	return {
		check,
		passed: false,
		message: `No 'await ${check.call}' pattern found — call may exist but is not awaited`,
	};
}

// --- await_absent ---
// Verify a specific function call is NOT awaited
function checkAwaitAbsent(
	sourceFile: SourceFile,
	check: Extract<AstCheck, { type: "await_absent" }>,
): AstCheckResult {
	const awaitExpressions = sourceFile.getDescendantsOfKind(
		SyntaxKind.AwaitExpression,
	);

	for (const awaitExpr of awaitExpressions) {
		const expression = awaitExpr.getExpression();
		const exprText = expression.getText();
		if (matchesCallPattern(exprText, check.call)) {
			return {
				check,
				passed: false,
				message: `Found unwanted 'await ${check.call}' — this call should NOT be awaited`,
			};
		}
		// Also check the callee of CallExpressions (e.g., `await foo({...})` should match pattern `foo`)
		if (Node.isCallExpression(expression)) {
			const calleeText = expression.getExpression().getText();
			if (matchesCallPattern(calleeText, check.call)) {
				return {
					check,
					passed: false,
					message: `Found unwanted 'await ${check.call}(...)' — this call should NOT be awaited`,
				};
			}
		}
	}

	return {
		check,
		passed: true,
		message: `'${check.call}' is correctly not awaited`,
	};
}

// --- call_exists ---
// Verify a function/method call exists, or a JSX element usage, or a property access on an object
function checkCallExists(
	sourceFile: SourceFile,
	check: Extract<AstCheck, { type: "call_exists" }>,
): AstCheckResult {
	const callPattern = check.call;

	// Handle dotted patterns like "config.matcher" — check for property in an exported object
	if (callPattern.includes(".") && !callPattern.includes("(")) {
		const [objectName, propertyName] = callPattern.split(".");
		if (objectName && propertyName) {
			if (findPropertyInExportedObject(sourceFile, objectName, propertyName)) {
				return {
					check,
					passed: true,
					message: `Found '${objectName}' with property '${propertyName}'`,
				};
			}

			// Also check for property access call (e.g., ReactDOM.render)
			if (findPropertyAccessCall(sourceFile, objectName, propertyName)) {
				return {
					check,
					passed: true,
					message: `Found call to ${objectName}.${propertyName}()`,
				};
			}
		}
	}

	// Handle dotted call patterns like "ReactDOM.render" — method calls on objects
	if (callPattern.includes(".")) {
		const parts = callPattern.split(".");
		const objectName = parts[0];
		const methodName = parts[parts.length - 1];
		if (objectName && methodName) {
			if (findPropertyAccessCall(sourceFile, objectName, methodName)) {
				return {
					check,
					passed: true,
					message: `Found call to ${callPattern}()`,
				};
			}

			// Fallback for destructured imports: the agent may write
			//   `import { render } from 'react-dom'; render(...)`
			// instead of `ReactDOM.render(...)`. Accept standalone calls to the method
			// name when it was brought in via a named import.
			if (findNamedImportCall(sourceFile, methodName)) {
				return {
					check,
					passed: true,
					message: `Found call to imported '${methodName}()' (destructured equivalent of ${callPattern})`,
				};
			}
		}
	}

	// Check for regular function calls (e.g., `use(...)`)
	const callExpressions = sourceFile.getDescendantsOfKind(
		SyntaxKind.CallExpression,
	);
	for (const callExpr of callExpressions) {
		const exprText = callExpr.getExpression().getText();
		if (exprText === callPattern || matchesCallPattern(exprText, callPattern)) {
			return {
				check,
				passed: true,
				message: `Found call to '${callPattern}()'`,
			};
		}
	}

	// Check for JSX element usage (e.g., `<Suspense>`)
	if (findJsxElement(sourceFile, callPattern)) {
		return {
			check,
			passed: true,
			message: `Found JSX element <${callPattern}>`,
		};
	}

	return {
		check,
		passed: false,
		message: `No call/usage of '${callPattern}' found`,
	};
}

// --- call_absent ---
// Verify a function/method call does NOT exist
function checkCallAbsent(
	sourceFile: SourceFile,
	check: Extract<AstCheck, { type: "call_absent" }>,
): AstCheckResult {
	const callPattern = check.call;

	// Check regular function calls
	const callExpressions = sourceFile.getDescendantsOfKind(
		SyntaxKind.CallExpression,
	);
	for (const callExpr of callExpressions) {
		const exprText = callExpr.getExpression().getText();
		if (exprText === callPattern || matchesCallPattern(exprText, callPattern)) {
			return {
				check,
				passed: false,
				message: `Found unwanted call to '${callPattern}()'`,
			};
		}
	}

	// Check for dotted method calls
	if (callPattern.includes(".")) {
		const parts = callPattern.split(".");
		const objectName = parts[0];
		const methodName = parts[parts.length - 1];
		if (
			objectName &&
			methodName &&
			findPropertyAccessCall(sourceFile, objectName, methodName)
		) {
			return {
				check,
				passed: false,
				message: `Found unwanted call to ${callPattern}()`,
			};
		}
	}

	// Check for JSX element usage
	if (findJsxElement(sourceFile, callPattern)) {
		return {
			check,
			passed: false,
			message: `Found unwanted JSX element <${callPattern}>`,
		};
	}

	return {
		check,
		passed: true,
		message: `'${callPattern}' is correctly absent`,
	};
}

// --- directive_present ---
// Verify a string directive exists at file level (e.g., 'use cache', 'use server')
function checkDirectivePresent(
	sourceFile: SourceFile,
	check: Extract<AstCheck, { type: "directive_present" }>,
): AstCheckResult {
	// Directives are expression statements containing string literals at the top of the file
	const statements = sourceFile.getStatements();
	for (const stmt of statements) {
		if (Node.isExpressionStatement(stmt)) {
			const expr = stmt.getExpression();
			if (Node.isStringLiteral(expr)) {
				if (expr.getLiteralValue() === check.directive) {
					return {
						check,
						passed: true,
						message: `Found directive '${check.directive}'`,
					};
				}
			}
		}
	}

	// Also check for directives in the full text as a fallback (handles non-standard positions)
	const fullText = sourceFile.getFullText();
	const directivePatterns = [`'${check.directive}'`, `"${check.directive}"`];
	for (const pattern of directivePatterns) {
		if (fullText.includes(pattern)) {
			return {
				check,
				passed: true,
				message: `Found directive '${check.directive}' in source text`,
			};
		}
	}

	return {
		check,
		passed: false,
		message: `Directive '${check.directive}' not found`,
	};
}

// --- property_location ---
// Verify a property is inside a specific call expression (e.g., `transformer` inside `httpBatchLink({})`)
function checkPropertyLocation(
	sourceFile: SourceFile,
	check: Extract<AstCheck, { type: "property_location" }>,
): AstCheckResult {
	const callExpressions = sourceFile.getDescendantsOfKind(
		SyntaxKind.CallExpression,
	);

	for (const callExpr of callExpressions) {
		const exprText = callExpr.getExpression().getText();
		if (
			exprText === check.insideCall ||
			matchesCallPattern(exprText, check.insideCall)
		) {
			// Look for property assignments inside this call's arguments
			const args = callExpr.getArguments();
			for (const arg of args) {
				if (Node.isObjectLiteralExpression(arg)) {
					const properties = arg.getProperties();
					for (const prop of properties) {
						if (
							Node.isPropertyAssignment(prop) ||
							Node.isShorthandPropertyAssignment(prop)
						) {
							if (prop.getName() === check.property) {
								return {
									check,
									passed: true,
									message: `Found property '${check.property}' inside call to '${check.insideCall}()'`,
								};
							}
						}
					}
				}
			}
		}
	}

	return {
		check,
		passed: false,
		message: `Property '${check.property}' not found inside call to '${check.insideCall}()'`,
	};
}

// --- async_function ---
// Verify a function is async
function checkAsyncFunction(
	sourceFile: SourceFile,
	check: Extract<AstCheck, { type: "async_function" }>,
): AstCheckResult {
	const functions = sourceFile.getFunctions();

	if (check.name) {
		// Check for a specific function name
		for (const fn of functions) {
			if (fn.getName() === check.name && fn.isAsync()) {
				return {
					check,
					passed: true,
					message: `Function '${check.name}' is async`,
				};
			}
		}

		// Also check arrow functions and function expressions assigned to variables
		const variableDecls = sourceFile.getDescendantsOfKind(
			SyntaxKind.VariableDeclaration,
		);
		for (const decl of variableDecls) {
			if (decl.getName() === check.name) {
				const initializer = decl.getInitializer();
				if (
					initializer &&
					(Node.isArrowFunction(initializer) ||
						Node.isFunctionExpression(initializer))
				) {
					if (initializer.isAsync()) {
						return {
							check,
							passed: true,
							message: `Function '${check.name}' is async (arrow/expression)`,
						};
					}
				}
			}
		}

		// Check exported default function
		const defaultExport = sourceFile.getDefaultExportSymbol();
		if (defaultExport && check.name === "default") {
			const decls = defaultExport.getDeclarations();
			for (const decl of decls) {
				if (Node.isFunctionDeclaration(decl) && decl.isAsync()) {
					return {
						check,
						passed: true,
						message: "Default exported function is async",
					};
				}
			}
		}

		return {
			check,
			passed: false,
			message: `Function '${check.name}' is not async or not found`,
		};
	}

	// No name specified — check if any function is async
	for (const fn of functions) {
		if (fn.isAsync()) {
			return {
				check,
				passed: true,
				message: "Found an async function",
			};
		}
	}

	// Check arrow functions too
	const arrowFns = sourceFile.getDescendantsOfKind(SyntaxKind.ArrowFunction);
	for (const fn of arrowFns) {
		if (fn.isAsync()) {
			return { check, passed: true, message: "Found an async arrow function" };
		}
	}

	return {
		check,
		passed: false,
		message: "No async function found",
	};
}

// --- async_generator ---
// Verify a function uses `async function*` pattern
function checkAsyncGenerator(
	sourceFile: SourceFile,
	check: Extract<AstCheck, { type: "async_generator" }>,
): AstCheckResult {
	const functions = sourceFile.getFunctions();

	for (const fn of functions) {
		if (check.name && fn.getName() !== check.name) continue;
		if (fn.isAsync() && fn.isGenerator()) {
			const name = fn.getName() || "anonymous";
			return {
				check,
				passed: true,
				message: `Found async generator function '${name}'`,
			};
		}
	}

	// Check method declarations too
	const methods = sourceFile.getDescendantsOfKind(SyntaxKind.MethodDeclaration);
	for (const method of methods) {
		if (check.name && method.getName() !== check.name) continue;
		if (method.isAsync() && method.isGenerator()) {
			return {
				check,
				passed: true,
				message: `Found async generator method '${method.getName()}'`,
			};
		}
	}

	// Check function expressions (e.g., async function*() used as callback argument)
	const functionExprs = sourceFile.getDescendantsOfKind(
		SyntaxKind.FunctionExpression,
	);
	for (const fn of functionExprs) {
		if (check.name && fn.getName() !== check.name) continue;
		if (fn.isAsync() && fn.isGenerator()) {
			const name = fn.getName() || "anonymous";
			return {
				check,
				passed: true,
				message: `Found async generator function expression '${name}'`,
			};
		}
	}

	return {
		check,
		passed: false,
		message: check.name
			? `No async generator function '${check.name}' found`
			: "No async generator function found",
	};
}

// --- yield_present ---
// Verify `yield` keyword is used inside a function
function checkYieldPresent(
	sourceFile: SourceFile,
	check: Extract<AstCheck, { type: "yield_present" }>,
): AstCheckResult {
	const yieldExpressions = sourceFile.getDescendantsOfKind(
		SyntaxKind.YieldExpression,
	);

	if (check.name) {
		// Check that yield is inside a specific function
		for (const yieldExpr of yieldExpressions) {
			const containingFn = yieldExpr.getFirstAncestor((node) => {
				if (Node.isFunctionDeclaration(node)) {
					return node.getName() === check.name;
				}
				if (Node.isMethodDeclaration(node)) {
					return node.getName() === check.name;
				}
				return false;
			});
			if (containingFn) {
				return {
					check,
					passed: true,
					message: `Found 'yield' inside function '${check.name}'`,
				};
			}
		}

		return {
			check,
			passed: false,
			message: `No 'yield' found inside function '${check.name}'`,
		};
	}

	// No name specified — check if any yield exists
	if (yieldExpressions.length > 0) {
		return {
			check,
			passed: true,
			message: "Found yield expression",
		};
	}

	return {
		check,
		passed: false,
		message: "No yield expression found",
	};
}

// --- type_annotation ---
// Verify a parameter has a specific type annotation
function checkTypeAnnotation(
	sourceFile: SourceFile,
	check: Extract<AstCheck, { type: "type_annotation" }>,
): AstCheckResult {
	const parameters = sourceFile.getDescendantsOfKind(SyntaxKind.Parameter);

	for (const param of parameters) {
		if (param.getName() === check.parameter) {
			const typeNode = param.getTypeNode();
			if (typeNode) {
				const typeText = typeNode.getText().replace(/\s+/g, " ").trim();
				const expectedText = check.annotation.replace(/\s+/g, " ").trim();
				if (typeText === expectedText) {
					return {
						check,
						passed: true,
						message: `Parameter '${check.parameter}' has type annotation '${check.annotation}'`,
					};
				}
			}
		}
	}

	// Also check destructured parameters by looking at the full text
	const fullText = sourceFile.getFullText();
	const normalizedText = fullText.replace(/\s+/g, " ");
	const pattern = `${check.parameter}:`;
	if (normalizedText.includes(pattern)) {
		const idx = normalizedText.indexOf(pattern);
		const afterColon = normalizedText.substring(idx + pattern.length).trim();
		const normalizedAnnotation = check.annotation.replace(/\s+/g, " ").trim();
		if (afterColon.startsWith(normalizedAnnotation)) {
			return {
				check,
				passed: true,
				message: `Found type annotation '${check.annotation}' for '${check.parameter}'`,
			};
		}
	}

	return {
		check,
		passed: false,
		message: `Parameter '${check.parameter}' does not have type annotation '${check.annotation}'`,
	};
}

// --- property_absent ---
// Verify a specific property does NOT exist in an object literal
function checkPropertyAbsent(
	sourceFile: SourceFile,
	check: Extract<AstCheck, { type: "property_absent" }>,
): AstCheckResult {
	if (check.inObject) {
		// Check inside a specific named exported object
		const exportedDeclarations = sourceFile.getExportedDeclarations();
		for (const [name, declarations] of exportedDeclarations) {
			if (name !== check.inObject) continue;
			for (const decl of declarations) {
				if (Node.isVariableDeclaration(decl)) {
					const initializer = decl.getInitializer();
					if (initializer && Node.isObjectLiteralExpression(initializer)) {
						if (hasProperty(initializer, check.property)) {
							return {
								check,
								passed: false,
								message: `Found unwanted property '${check.property}' in '${check.inObject}'`,
							};
						}
					}
				}
			}
		}

		return {
			check,
			passed: true,
			message: `Property '${check.property}' is correctly absent from '${check.inObject}'`,
		};
	}

	// No specific object — check ALL object literals in the file
	const objectLiterals = sourceFile.getDescendantsOfKind(
		SyntaxKind.ObjectLiteralExpression,
	);
	for (const obj of objectLiterals) {
		if (hasProperty(obj, check.property)) {
			return {
				check,
				passed: false,
				message: `Found unwanted property '${check.property}' in an object literal`,
			};
		}
	}

	return {
		check,
		passed: true,
		message: `Property '${check.property}' is correctly absent from all objects`,
	};
}

// --- Helper Functions ---

/**
 * Checks if an expression text matches a call pattern.
 * Handles patterns like "cookies", "cookies()", "ReactDOM.render", etc.
 */
function matchesCallPattern(exprText: string, pattern: string): boolean {
	// Strip trailing () from both for comparison
	const normalizedExpr = exprText.replace(/\(\)$/, "").trim();
	const normalizedPattern = pattern.replace(/\(\)$/, "").trim();
	return normalizedExpr === normalizedPattern;
}

/**
 * Finds a property access call like `ReactDOM.render(...)` in the source file.
 */
function findPropertyAccessCall(
	sourceFile: SourceFile,
	objectName: string,
	methodName: string,
): boolean {
	const callExpressions = sourceFile.getDescendantsOfKind(
		SyntaxKind.CallExpression,
	);
	for (const callExpr of callExpressions) {
		const expression = callExpr.getExpression();
		if (Node.isPropertyAccessExpression(expression)) {
			const obj = expression.getExpression().getText();
			const prop = expression.getName();
			if (obj === objectName && prop === methodName) {
				return true;
			}
		}
	}
	return false;
}

/**
 * Checks whether a function name was imported as a named import and then called
 * as a standalone function. This handles the "destructured import" pattern where
 * an agent writes:
 *
 *   import { render } from 'react-dom';
 *   render(<App />, root);
 *
 * instead of the namespace form:
 *
 *   import ReactDOM from 'react-dom';
 *   ReactDOM.render(<App />, root);
 *
 * Only returns true when BOTH conditions are met — the name is a named import
 * AND it is invoked as a call expression — to avoid false positives on local
 * variable method calls like `result.toDataStreamResponse()`.
 */
function findNamedImportCall(
	sourceFile: SourceFile,
	funcName: string,
): boolean {
	// Step 1: verify the name is brought in via a named import
	const imports = sourceFile.getImportDeclarations();
	let isNamedImport = false;
	for (const imp of imports) {
		for (const named of imp.getNamedImports()) {
			if (named.getName() === funcName) {
				isNamedImport = true;
				break;
			}
		}
		if (isNamedImport) break;
	}
	if (!isNamedImport) return false;

	// Step 2: verify the name is called as a standalone function
	const callExpressions = sourceFile.getDescendantsOfKind(
		SyntaxKind.CallExpression,
	);
	for (const callExpr of callExpressions) {
		const expression = callExpr.getExpression();
		// Only match plain identifier calls (e.g., `render(...)`) — not property
		// access calls (e.g., `obj.render(...)`) which are a different pattern.
		if (Node.isIdentifier(expression) && expression.getText() === funcName) {
			return true;
		}
	}
	return false;
}

/**
 * Finds a property in an exported object literal (e.g., `export const config = { matcher: ... }`).
 */
function findPropertyInExportedObject(
	sourceFile: SourceFile,
	objectName: string,
	propertyName: string,
): boolean {
	const exportedDeclarations = sourceFile.getExportedDeclarations();
	for (const [name, declarations] of exportedDeclarations) {
		if (name !== objectName) continue;
		for (const decl of declarations) {
			if (Node.isVariableDeclaration(decl)) {
				const initializer = decl.getInitializer();
				if (initializer && Node.isObjectLiteralExpression(initializer)) {
					if (hasProperty(initializer, propertyName)) {
						return true;
					}
				}
			}
		}
	}
	return false;
}

/**
 * Checks if an ObjectLiteralExpression has a property with the given name.
 */
function hasProperty(
	obj: import("ts-morph").ObjectLiteralExpression,
	propertyName: string,
): boolean {
	const properties = obj.getProperties();
	for (const prop of properties) {
		if (
			Node.isPropertyAssignment(prop) ||
			Node.isShorthandPropertyAssignment(prop)
		) {
			if (prop.getName() === propertyName) {
				return true;
			}
		}
	}
	return false;
}

/**
 * Finds JSX element usage (both self-closing and opening elements).
 * Matches `<Suspense>`, `<Suspense />`, etc.
 */
function findJsxElement(sourceFile: SourceFile, elementName: string): boolean {
	// Check JSX opening elements
	const openingElements = sourceFile.getDescendantsOfKind(
		SyntaxKind.JsxOpeningElement,
	);
	for (const elem of openingElements) {
		if (elem.getTagNameNode().getText() === elementName) {
			return true;
		}
	}

	// Check JSX self-closing elements
	const selfClosingElements = sourceFile.getDescendantsOfKind(
		SyntaxKind.JsxSelfClosingElement,
	);
	for (const elem of selfClosingElements) {
		if (elem.getTagNameNode().getText() === elementName) {
			return true;
		}
	}

	return false;
}
