import Listr from "listr";
import { apiV8, apiV9, sourceIsV8 } from "../api.js";
import { typeMap } from "../constants/type-map.js";
import { interfaceMap } from "../constants/interface-map.js";
import { writeContext, commandLineOptions } from "../index.js";

export async function migrateSchema(context) {
	context.section = "schema";

	return new Listr([
		{
			title: "Creating Collections",
			skip: (context) => context.completedSteps.collections === true,
			task: () => migrateCollections(context),
		},
		{
			title: "Saving collections context",
			skip: (context) => context.completedSteps.collections === true,
			task: () => {
				context.section = "collections";
				writeContext(context);
			},
		},
	]);
}

export async function downloadSchema(context) {
	const response = await apiV8.get("/collections");
	context.collections = response.data.data
		.filter(
			(collection) => collection.collection.startsWith("directus_") === false
		)
		.filter(
			(collection) => !context.skipCollections.includes(collection.collection)
		);

	if (context.onlyCollections !== []) {
		context.collections = context.collections.filter(
			(collection) => context.onlyCollections.includes(collection.collection)
		);
	}

	if (!sourceIsV8()) {
		// In Directus V9, fields are not included on the collections model.
		// They need to be fetched independently.
		// TODO: add filter to current collection
		const fieldsResponse = await apiV8.get("/fields");
		context.fields = fieldsResponse.data.data
			.filter(
				(field) => field.collection.startsWith("directus_") === false
			)
			.filter(
				(field) => !context.skipCollections.includes(field.collection)
			);
		// console.log('ROB: context.fields : %o', context.fields)
		// context.collections.forEach(collection =>
		// 	collection.fields = context.fields.find(field => field.collection === collection.collection)
		// )
		context.collections.forEach(collection =>
			collection.fields = context.fields.filter(
				(field) => {
					return field.collection === collection.collection;
				}
			)
		)
	}
}

async function migrateCollections(context) {
	return new Listr(
		context.collections.map((collection) => ({
			title: collection.collection,
			task: migrateCollection(collection, context),
		}))
	);
}

function migrateFieldOptions(fieldDetails) {
	if (fieldDetails.interface === "divider") {
		return {
			title: fieldDetails.options.title,
			marginTop: fieldDetails.options.margin,
		};
	}

	if (fieldDetails.interface === "status") {
		return {
			choices: Object.values(fieldDetails.options.status_mapping).map(
				({ name, value }) => ({
					text: name,
					value: value,
				})
			),
		};
	}

	if (fieldDetails.interface === "dropdown") {
		return {
			choices: Object.entries(fieldDetails.options.choices).map(
				([value, text]) => ({
					text,
					value,
				})
			),
			placeholder: fieldDetails.options.placeholder,
		};
	}

	if (
		fieldDetails.interface === "repeater" &&
		fieldDetails.options.dataType === "object"
	) {
		const fieldKeys = Object.keys(fieldDetails.options.fields);
		const fields = fieldDetails.options.fields;
		return {
			fields: fieldKeys.map((field) => ({
				name: field,
				type: fields[field].type,
				field: field,
				meta: {
					name: field,
					type: fields[field].type,
					field: field,
					width: fields[field].width,
					interface: fields[field].interface,
					options: migrateFieldOptions(field),
				},
			})),
		};
	}

	if (fieldDetails.interface === "repeater") {
		return {
			fields: fieldDetails.options.fields.map((field) => ({
				name: field.field,
				type: field.type,
				field: field.field,
				meta: {
					name: field.field,
					type: field.type,
					field: field.field,
					width: field.width,
					interface: field.interface,
					options: migrateFieldOptions(field),
				},
			})),
		};
	}

	if (fieldDetails.interface === "checkboxes") {
		return {
			choices: Object.entries(fieldDetails.options.choices).map(
				([value, text]) => ({
					text,
					value,
				})
			),
			allowOther: fieldDetails.options.allow_other,
		};
	}

	if (fieldDetails.interface === "input-rich-text-html") {
		return fieldDetails.options;
	}

	if (fieldDetails.interface === "many-to-one") {
		let obj = {};
		if (fieldDetails.options.template) {
			obj.template = fieldDetails.options.template;
		}
		return obj || null;
	}

	if (fieldDetails.interface === "many-to-many") {
		let obj = {};
		if (fieldDetails.options.template) {
			let templateWithoutBraces = fieldDetails.options.template
				.replace("{{", "")
				.replace("}}", "")
				.trim();
			obj.template =
				"{{" + fieldDetails.field + "_id." + templateWithoutBraces + "}}";
		}
		if (fieldDetails.options.allow_create) {
			obj.enableCreate = fieldDetails.options.allow_create;
		}
		if (fieldDetails.options.allow_select) {
			obj.enableSelect = fieldDetails.options.allow_select;
		}
		return obj || null;
	}
}

function migrateCollection(collection, context) {
	const fields = context.fields

	const collectionFields = Object.values(fields).filter(
		(field) => field.collection === collection.collection
	);

	return async () => {
		const statusField = collection.meta.archive_field;
		const collectionV9 = {
			collection: collection.collection,
			meta: (!(sourceIsV8()) ?
					collection.meta
				:
				{
				note: collection.note,
				hidden: collection.hidden,
				singleton: collection.single,
				icon: collection.icon,
				translations: collection.translation?.map(
					({ locale, translation }) => ({
						language: locale,
						translation,
					})
				),
				sort_field:
					Object.entries(collection.fields).find(([field, details]) => {
						return (details.type || "").toLowerCase() === "sort";
					})?.field || null,
				...(statusField
					? {
							archive_field: statusField.field,
							archive_value: Object.values(
								statusField.options.status_mapping
							).find((option) => option.soft_delete)?.value,
							unarchive_value: Object.values(
								statusField.options.status_mapping
							).find((option) => !option.soft_delete && !option.published)
								.value,
					  }
					: {}),
			}),
			// schema: {}, // TODO: does this work for
			schema: collection.schema,
			fields: Object.values(collectionFields).map((details) => {
				// const relation =
				// 	context.relationsV8Map?.[collection.collection]?.[details.field] ||
				// 	{};

				// const isUuid =
				// 	details.field.includes("directus_files_id") ||
				// 	details.interface === "user-roles" ||
				// 	["directus_files", "directus_users"].includes(
				// 		relation?.collection_one
				// 	);

				return {
					field: details.field,
					// type: details.datatype,
					type: details.type,
					// type:
					// 	details.datatype?.toLowerCase() === "text" ||
					// 	details.datatype?.toLowerCase() === "longtext"
					// 		? "text"
					// 		: details.interface === "many-to-many"
					// 		? "m2m"
					// 		: isUuid
					// 		? "uuid"
					// 		: typeMap[details.type.toLowerCase()],
					meta: details.meta,
					// meta: {
					// 		note: details.note,
					// 	interface: interfaceMap[(details.interface || "").toLowerCase()],
					// 	translations: details.translation?.map(
					// 		({ locale, translation }) => ({
					// 			language: locale,
					// 			translation,
					// 		})
					// 	),
					// 	readonly: details.readonly,
					// 	hidden: details.hidden_detail,
					// 	width: details.width,
					// 	special: extractSpecial(details),
					// 	sort: details.sort,
					// 	options: migrateFieldOptions(details),
					// },
					// schema:
					// 	["alias", "o2m"].includes(typeMap[details.type.toLowerCase()]) ===
					// 	false
					// 		? {
					// 				has_auto_increment: details.auto_increment,
					// 				default_value: extractValue(details),
					// 				is_primary_key: details.primary_key,
					// 				is_nullable: details.required === false,
					// 				max_length: details.length,
					// 				numeric_precision:
					// 					(details.length || "").split(",")[0] || null,
					// 				numeric_scale: (details.length || "").split(",")[1] || null,
					// 		  }
					// 		: undefined,
					// schema: details.schema
					// ["alias", "o2m"].includes(typeMap[details.type.toLowerCase()]) === false
					schema:
						["alias", "o2m"].includes(details.type.toLowerCase()) === false
						? details.schema
						: undefined,
				};
			}),
		};
		if (commandLineOptions.exportOnly)
			return;
		context.collectionsV9.push(collectionV9);
		await apiV9.post("/collections", collectionV9);
	};

	function extractValue(details) {
		if (typeMap[details.type.toLowerCase()] === "json") {
			try {
				JSON.parse(details.default_value);
			} catch (ex) {
				return JSON.stringify(details.default_value);
			}
		}

		return details.default_value;
	}

	function extractSpecial(details) {
		const type =
			details.interface === "many-to-many" ? "m2m" : details.type.toLowerCase();
		if (type === "alias") {
			return ["alias", "no-data"];
		}

		if (type === "boolean") {
			return ["boolean"];
		}

		if (type === "hash") {
			return ["hash"];
		}

		if (type === "json") {
			return ["json"];
		}

		if (type === "uuid") {
			return ["uuid"];
		}

		if (type === "owner") {
			return ["user-created"];
		}

		if (type === "user_updated") {
			return ["user-updated"];
		}

		if (type === "datetime_created") {
			return ["date-created"];
		}

		if (type === "datetime_updated") {
			return ["date-updated"];
		}

		if (type === "csv") {
			return ["csv"];
		}

		if (type === "o2m") {
			return ["o2m"];
		}

		if (type === "m2m") {
			return ["m2m"];
		}

		if (type === "m2o") {
			return ["m2o"];
		}
	}
}
