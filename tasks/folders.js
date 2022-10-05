import Listr from "listr";
import { apiV8, apiV9 } from "../api.js";
import { writeContext, commandLineOptions } from "../index.js";

export async function migrateFolders(context) {

	// apiV8.interceptors.request.use(request => {
	// 	console.log('Starting FOLDERS Request', JSON.stringify(request, null, 2))
	// 	return request
	// });

	context.section = "folders";

	return new Listr([
		{
			title: "Getting Folder Count",
			task: getCount,
		},
		{
			title: "Uploading Folders",
			task: uploadFolders,
		},
		{
			title: "Saving context",
			task: () => writeContext(context),
		},
	]);
}

async function getCount(context) {
	let count_params = {
		limit: 1,
		meta: "total_count",
	}
	const count = await apiV8.get("/folders", {params: count_params});
	context.folderCount = count.data.meta.total_count;
	console.log('FOLDERS: folderCount=%o', context.folderCount);
}

async function uploadFolders(context) {
	const pages = Math.ceil(context.folderCount / 100);
	const tasks = [];
	for (let i = 0; i < pages; i++) {
		tasks.push({
			title: `Uploading folders ${i * 100 + 1}—${(i + 1) * 100}`,
			task: uploadBatch(i),
		});
	}
	return new Listr(tasks, { concurrent: Math.ceil(tasks.length / 10) });
}

// TODO: concerns about this:
//   1. It doesn't appear to keep the ID of the source item.
//   2. It uses the /import endpoint, which does not support all fields
//   3. Requires a basic public read access to the source item ( can work around this )
function uploadBatch(page) {
	apiV9.interceptors.request.use(request => {
		// console.log('Starting FOLDERS Request', JSON.stringify(request, null, 2))
		return request
	});

	return async (context, task) => {
		const records = await apiV8.get("/folders", {
			params: {
				offset: page * 100,
				limit: 100,
				// filter: context.folders_filter,
			},
		});

		if (commandLineOptions.exportOnly)
			return;

		for (const folderRecord of records.data.data) {
			// console.log('ROB: uploadBatch processing folderRecord %o', folderRecord)
			// Needed a try/catch here as Directus is returning a 403 instead of 404 for a non-match
			try {
				const existingFolder = await apiV9.get(`/folders/${folderRecord.id}`);
				// console.log('FOLDERS: existing folder check result:%o', existingFolder);
				const migratedFolder = existingFolder.data.data;
				// console.log('FOLDERS: existing folder check returned data:%o', migratedFolder);
				if (existingFolder.status === 200) {
					// console.log('FOLDERS: skipping existing migrated folder for %s, migrated id %s', folderRecord.id, migratedFolder.id);
					continue;
				}
			} catch (error) {
			}
			// return;
			// const url = process.env.V9_URL + "/folders/" + folderRecord.id;
			// apiV9.interceptors.request.use(request => {
			// 	console.log('Starting FOLDERS Request', JSON.stringify(request, null, 2))
			// 	return request
			// });
			const url = process.env.V9_URL + "/folders";
			const folderData = {
				id: folderRecord.id,
				name: folderRecord.name,
				parent: folderRecord.parent,
			};

			// console.log('ROB: folder upload url=%o', url)
			// console.log('ROB: folder upload data=%o', folderData)
			const savedFolder = await apiV9.post(
				url,
				folderData,
			);
			// console.log('FOLDERS: upload result:%o', savedFolder);
		}
	};
}
