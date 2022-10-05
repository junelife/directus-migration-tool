import Listr from "listr";
import { apiV8, apiV9, sourceIsV8 } from "../api.js";
import { writeContext, commandLineOptions } from "../index.js";

export async function fetchRelations(context) {
	context.section = "relationsv8";

	return new Listr([
		{
			title: "Get v8 Relations",
			task: () => getRelationsData(context),
			skip: (context) => context.completedSteps.relationsv8 === true,
		},
		{
			title: "Saving Relations context",
			task: () => writeContext(context),
			skip: (context) => context.completedSteps.relationsv8 === true,
		},
	]);
}

export async function migrateRelations(context) {
	context.section = "relations";

	return new Listr([
		{
			title: "Migrating Relations",
			task: () => migrateRelationsData(context),
			skip: (context) => context.completedSteps.relations === true,
		},
		{
			title: "Saving Relations context",
			task: () => writeContext(context),
			skip: (context) => context.completedSteps.relations === true,
		},
	]);
}

async function getRelationsData(context) {
	const relations = await apiV8.get("/relations", { params: { limit: -1 } });
	context.relationsV8 = relations.data.data;
	context.relationsV8Map = relations.data.data.reduce(
		(map, relation) => ({
			...map,
			[relation.collection_many]: {
				...map[relation.collection_many],
				[relation.field_many]: relation,
			},
		}),
		{}
	);
	context.relationsMigrated = context.relationsMigrated || {};
}

async function migrateRelationsData(context) {
	const migrated = [];

	if (commandLineOptions.exportOnly)
		return;

	const relationsV9 = context.relationsV8.flatMap((relation) => {
		if (context.relationsMigrated[relation.id]) return [];
		migrated.push(relation.id);

		if (sourceIsV8()) {
			if (relation.collection_many.startsWith("directus_")) return [];

			return [
			{
				meta: {
					many_collection: relation.collection_many,
					many_field: relation.field_many,
					one_collection: relation.collection_one,
					one_field: relation.field_one,
					junction_field: relation.junction_field,
				},
				field: relation.field_many,
				collection: relation.collection_many,
				related_collection: relation.collection_one,
				schema: null,
			},
			];
		} else {
			if (relation.meta.many_collection.startsWith("directus_")) return [];
			return [relation];
		}
	});

	const systemFields = context.collections
		.map((collection) =>
			Object.values(collection.fields)
				.filter((details) => {
					return (
						details.type === "file" ||
						details.type.startsWith("user") ||
						details.type === "owner"
					);
				})
				.map((field) => ({
					meta: {
						many_field: field.field,
						many_collection: collection.collection,
						one_collection:
							field.type === "file" ? "directus_files" : "directus_users",
					},
					field: field.field,
					collection: collection.collection,
					related_collection:
						field.type === "file" ? "directus_files" : "directus_users",
					schema: null,
				}))
		)
		.flat();

	// TODO: skip for "dataOnly"
	// TODO: this context data is needed for other functions,
	// TODO: even if not uploaded to target
	// for (const relation of [...relationsV9, ...systemFields]) {
	// 	await apiV9.post("/relations", relation);
	// }

	context.relations = [...relationsV9, ...systemFields];

	for (const id of migrated) {
		context.relationsMigrated[id] = true;
	}

	await writeContext(context, false);
}
