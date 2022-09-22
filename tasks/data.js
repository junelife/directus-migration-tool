import Listr from "listr";
import { apiV8, apiV9, sourceIsV8 } from "../api.js";
import { writeContext } from "../index.js";

const LIMIT = 10;

export async function migrateData(context) {
	context.section = "data";

	return new Listr([
		{
			title: "Getting Counts",
			task: async () => await getCounts(context),
		},
		{
			title: "Inserting Data",
			task: async () => await insertData(context),
		},
		{
			title: "Saving context",
			task: () => writeContext(context),
		},
	]);
}

async function getCounts(context) {
	context.counts = context.counts || {};
	context.dataMap = context.dataMap || {};

	if (Object.keys(context.counts).length) return;

	for (const collection of context.collections) {
		const contextCollection = context.collectionsV9.find(
			(c) => c.collection === collection.collection
		);

		// TODO: see if there's a better schema element to examine
		// Do not treat V9 folders as collections
		if (collection.meta.icon === 'folder') return;

		let hasStatus = false;
		const params = {
			limit: 1,
			meta: "total_count",
		};

		if (contextCollection && contextCollection?.meta?.archive_value) {
			hasStatus = true;
			params.meta = "*";
		}

		const count = await apiV8.get(`/items/${collection.collection}`, {
			params,
		});

		if (hasStatus) {
			if (sourceIsV8()) {
				context.counts[collection.collection] = Object.keys(
					count.data.meta.status_count
				).reduce((acc, cur) => acc + count.data.meta.status_count[cur], 0);
			} else {
				context.counts[collection.collection] = count.data.meta.filter_count
			}
		} else {
			context.counts[collection.collection] = count.data.meta.total_count;
		}
	}
}

function isJunctionCollection(note) {
	const junctionCollectionNames = [
		"連接點集合",
		"交叉集合",
		"中継コレクション",
		"Узловая Коллекция",
		"Verbindingscollectie",
		"Verbindungssammlung",
		"Збірна колекція",
		"Spojovací kategorie",
		"Junction Collection",
		"Pengumpulan Persimpangan",
		"Kesişim Koleksiyonu",
		"مجموعة تلاقي",
		"Kolekcja Junction",
		"Jução da coleção",
		"Koleksi Persimpangan",
		"Collezione Junction",
		"Colección de empalme",
		"Collection de jonction",
		"Colección de unión",
	];

	return junctionCollectionNames.includes(note);
}

// This is definitely a hack to achieve first adding items of collections that have dependencies in other collections i.e m2m, o2m
// FIXME: Implement a more robust solution to sort collections based on their dependencies, or swap to a different way to seed the data
function moveJunctionCollectionsBack(a, b) {
	if (isJunctionCollection(a.note) || isJunctionCollection(b.note)) {
		if (isJunctionCollection(a.note)) {
			return 1;
		}

		if (isJunctionCollection(b.note)) {
			return -1;
		}
	}

	return 0;
}

function moveManyToOne(a, b) {
	if (
		Object.values(a.fields).find(
			(element) => element.interface === "many-to-one"
		)
	) {
		return 1;
	}

	if (
		Object.values(b.fields).find(
			(element) => element.interface === "many-to-one"
		)
	) {
		return -1;
	}

	return 0;
}

function moveByCustomOrder(collectionOrder) {
	return (a, b) => {
		return (
			collectionOrder.indexOf(a.collection) -
			collectionOrder.indexOf(b.collection)
		);
	};
}

async function insertData(context) {
	let sortedCollections;

	if (process.env.COLLECTION_ORDER) {
		const collectionOrder = process.env.COLLECTION_ORDER.split(",").map(
			(entry) => entry.trim()
		);
		sortedCollections = context.collections.sort(
			moveByCustomOrder(collectionOrder)
		);
	} else {
		sortedCollections = context.collections
			.sort(moveManyToOne)
			.sort(moveJunctionCollectionsBack);
	}

	return new Listr(
		sortedCollections.map((collection) => ({
			title: collection.collection,
			task: insertCollection(collection),
		}))
	);
}

function insertCollection(collection) {
	return async (context, task) => {
		if (
			Object.keys(context.dataMap[collection.collection] || {}).length ===
			context.counts[collection.collection]
		)
			return;

		const pages = Math.ceil(context.counts[collection.collection] / LIMIT);

		for (let i = 0; i < pages; i++) {
			task.output = `Inserting items ${i * LIMIT + 1}—${(i + 1) * LIMIT}/${
				context.counts[collection.collection]
			}`;
			await insertBatch(collection, i, context, task);
		}
	};
}

async function insertBatch(collection, page, context, task) {
	const contextCollection = context.collectionsV9.find(
		(c) => c.collection === collection.collection
	);

	const getRecordsResponse = () => {
		const params = {
			offset: page * LIMIT,
			limit: LIMIT,
			// when fetching UUID-based collection,
			// unsorted not returning all data with pagination.
			sort: collection.fields.find((field) =>
				(field.schema.is_primary_key === true)
			).field,
		};

		if (contextCollection && contextCollection?.meta?.archive_value) {
			params.status = "*";
		}

		return apiV8.get(`/items/${collection.collection}`, {
			params,
		});
	};

	let recordsResponse;

	try {
		recordsResponse = await getRecordsResponse();
	} catch {
		// try again hacky hacky. We'll let it crash and burn on a second failure
		await sleep(500);
		recordsResponse = await getRecordsResponse();
	}

	const systemRelationsForCollection = context.relations.filter((relation) => {
		return (
			relation?.meta?.many_collection === collection.collection &&
			relation?.meta?.one_collection.startsWith("directus_")
		);
	});

	const datetimeFields = Object.values(collection.fields).filter((field) =>
		["datetime", "date"].includes(field.type)
	);

	const aliasFields = Object.values(collection.fields).filter((field) =>
		["alias", "o2m"].includes(field.type)
	);

	let itemRecords = recordsResponse.data.data.flatMap((item) => {
		for (const alias of aliasFields) {
			delete item[alias.field];
		}

		if (context.dataMap?.[collection.collection]?.[item.id]) return [];

		if (
			systemRelationsForCollection.length === 0 &&
			datetimeFields.length === 0
		)
			return [item];

		for (const systemRelation of systemRelationsForCollection) {
			if (systemRelation?.meta?.one_collection === "directus_users") {
				item[systemRelation?.meta?.many_field] =
					context.userMap[item[systemRelation?.meta?.many_field]];
			} else if (systemRelation?.meta?.one_collection === "directus_files") {
				item[systemRelation?.meta?.many_field] =
					context.fileMap[item[systemRelation?.meta?.many_field]];
			} else if (systemRelation?.meta?.one_collection === "directus_roles") {
				item[systemRelation?.meta?.many_field] =
					context.roleMap[item[systemRelation?.meta?.many_field]];
			}
		}

		for (const datetimeField of datetimeFields) {
			if (item[datetimeField.field])
				item[datetimeField.field] = new Date(
					item[datetimeField.field]
				).toISOString();
		}

		return [item];
	});

	// Retry failed batches, after removing failed elements
	while (true) {
		if (!itemRecords.length) return;
		try {
			if (collection.single === true) {
				await apiV9.patch(`/items/${collection.collection}`, itemRecords[0]);
			} else {
				await apiV9.post(`/items/${collection.collection}`, itemRecords);
			}
		} catch (error) {
			const re = /[^{]*(?<err>{[\s\S]+)/mig;
			let response = re.exec(error)

			const errors = JSON.parse(response.groups.err).errors
			let start = itemRecords.length;
			for (let e of errors) {
				if (e.extensions.code === 'RECORD_NOT_UNIQUE') {
					itemRecords = itemRecords.filter((item) => {
						return (item.id != e.extensions.invalid);
					})
				}
			}

			if ((context.allowFailures === false) &&
				(itemRecords.length === start)
			) {
				throw(error);
			}
		}
	}

	const collectionMap = itemRecords.reduce(
		(map, item) => ({
			...map,
			[item.id]: true,
		}),
		context.dataMap[collection.collection] || {}
	);

	context.dataMap = {
		...context.dataMap,
		[collection.collection]: collectionMap,
	};
	await writeContext(context, false);
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
