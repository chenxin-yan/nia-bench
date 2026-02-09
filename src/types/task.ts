import { z } from "zod";

// --- AST Check Schemas (Discriminated Union) ---

const ImportExistsCheckSchema = z.object({
	type: z.literal("import_exists"),
	name: z.string(),
	from: z.string(),
	file: z.string().optional(),
});

const ImportAbsentCheckSchema = z.object({
	type: z.literal("import_absent"),
	name: z.string(),
	from: z.string().optional(),
	file: z.string().optional(),
});

const ModuleImportAbsentCheckSchema = z.object({
	type: z.literal("module_import_absent"),
	module: z.string(),
	file: z.string().optional(),
});

const FunctionExportedCheckSchema = z.object({
	type: z.literal("function_exported"),
	name: z.string(),
	file: z.string().optional(),
});

const FunctionAbsentCheckSchema = z.object({
	type: z.literal("function_absent"),
	name: z.string(),
	file: z.string().optional(),
});

const AwaitPresentCheckSchema = z.object({
	type: z.literal("await_present"),
	call: z.string(),
	file: z.string().optional(),
});

const AwaitAbsentCheckSchema = z.object({
	type: z.literal("await_absent"),
	call: z.string(),
	file: z.string().optional(),
});

const CallExistsCheckSchema = z.object({
	type: z.literal("call_exists"),
	call: z.string(),
	file: z.string().optional(),
});

const CallAbsentCheckSchema = z.object({
	type: z.literal("call_absent"),
	call: z.string(),
	file: z.string().optional(),
});

const DirectivePresentCheckSchema = z.object({
	type: z.literal("directive_present"),
	directive: z.string(),
	file: z.string().optional(),
});

const PropertyLocationCheckSchema = z.object({
	type: z.literal("property_location"),
	property: z.string(),
	insideCall: z.string(),
	file: z.string().optional(),
});

const AsyncFunctionCheckSchema = z.object({
	type: z.literal("async_function"),
	name: z.string().optional(),
	file: z.string().optional(),
});

const AsyncGeneratorCheckSchema = z.object({
	type: z.literal("async_generator"),
	name: z.string().optional(),
	file: z.string().optional(),
});

const YieldPresentCheckSchema = z.object({
	type: z.literal("yield_present"),
	name: z.string().optional(),
	file: z.string().optional(),
});

const TypeAnnotationCheckSchema = z.object({
	type: z.literal("type_annotation"),
	parameter: z.string(),
	annotation: z.string(),
	file: z.string().optional(),
});

const PropertyAbsentCheckSchema = z.object({
	type: z.literal("property_absent"),
	property: z.string(),
	inObject: z.string().optional(),
	file: z.string().optional(),
});

export const AstCheckSchema = z.discriminatedUnion("type", [
	ImportExistsCheckSchema,
	ImportAbsentCheckSchema,
	ModuleImportAbsentCheckSchema,
	FunctionExportedCheckSchema,
	FunctionAbsentCheckSchema,
	AwaitPresentCheckSchema,
	AwaitAbsentCheckSchema,
	CallExistsCheckSchema,
	CallAbsentCheckSchema,
	DirectivePresentCheckSchema,
	PropertyLocationCheckSchema,
	AsyncFunctionCheckSchema,
	AsyncGeneratorCheckSchema,
	YieldPresentCheckSchema,
	TypeAnnotationCheckSchema,
	PropertyAbsentCheckSchema,
]);

// --- Rubric Criterion Schema ---

export const RubricCriterionSchema = z.object({
	name: z.string(),
	weight: z.number().min(0).max(1),
	description: z.string(),
});

// --- Test Spec Schema ---

export const TestSpecSchema = z.object({
	ast_checks: z.array(AstCheckSchema),
	type_check: z.boolean().optional(),
});

// --- Rubric Schema ---

export const RubricSchema = z.object({
	criteria: z.array(RubricCriterionSchema),
});

// --- Context Schema (for version-locked tasks) ---

export const TaskContextSchema = z.object({
	code: z.record(z.string(), z.string()).optional(),
	package_json: z.string().optional(),
});

// --- Main Task Schema ---

export const CategorySchema = z.enum([
	"bleeding_edge",
	"version_locked_write",
	"version_locked_audit",
]);

export const LibrarySchema = z.enum(["next", "react", "ai", "trpc", "zod"]);

export const TaskSchema = z.object({
	id: z.string(),
	category: CategorySchema,
	library: LibrarySchema,
	target_version: z.string(),
	prompt: z.string(),
	context: TaskContextSchema.optional(),
	reference_solution: z.string(),
	test_spec: TestSpecSchema,
	rubric: RubricSchema,
	common_hallucinations: z.array(z.string()),
});

// --- Inferred TypeScript types ---

export type AstCheck = z.infer<typeof AstCheckSchema>;
export type RubricCriterion = z.infer<typeof RubricCriterionSchema>;
export type TestSpec = z.infer<typeof TestSpecSchema>;
export type Rubric = z.infer<typeof RubricSchema>;
export type TaskContext = z.infer<typeof TaskContextSchema>;
export type Category = z.infer<typeof CategorySchema>;
export type Library = z.infer<typeof LibrarySchema>;
export type Task = z.infer<typeof TaskSchema>;
