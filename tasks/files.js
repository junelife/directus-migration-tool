import Listr from "listr";
import { apiV8, apiV9 } from "../api.js";
import { writeContext } from "../index.js";

export async function migrateFiles(context) {
	context.section = "files";
	context.files_filter = {
		// DEV testing asset, Fish_Whole, 8_FISH_WHOLE_Step5.mp4
		// 'id': {
		// 		'_eq':'175a722c-64d6-4da6-9d20-1d7cd5937b78'
		// 	}
	};

	return new Listr([
		{
			title: "Getting File Count",
			task: getCount,
		},
		{
			title: "Uploading Files",
			task: uploadFiles,
		},
		{
			title: "Saving context",
			task: () => writeContext(context),
		},
	]);
}

async function getCount(context) {
	// TODO: provide switch for filtered/unfiltered
	let count_params = {
		limit: 0,  // This works at least for V9
		meta: "filter_count",
		filter: context.files_filter,
	}

	const count = await apiV8.get("/files", {params: count_params});

	// TODO: provide switch for filtered/unfiltered
	context.fileCount = count.data.meta.total_count;
	context.fileCount = count.data.meta.filter_count;

	context.fileMap = context.fileMap || {};
	console.log('FILES: fileCount=%o', context.fileCount);
}

async function uploadFiles(context) {
	const pages = Math.ceil(context.fileCount / 100);

	const tasks = [];

	console.log("FILES: submitting tasks for %s pages of 100", pages);
	for (let i = 0; i < pages; i++) {
		console.log("FILES: submitting tasks for page %s", i);
		tasks.push({
			title: `Uploading files ${i * 100 + 1}—${(i + 1) * 100}`,
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
	return async (context, task) => {
		const records = await apiV8.get("/files", {
			params: {
				offset: page * 100,
				limit: 100,
				filter: context.files_filter,
				// when fetching from UUID-based collections,
				// unsorted not returning all data with pagination.
				sort: 'id',
			},
		});

		for (const fileRecord of records.data.data) {
			if (context.fileMap[fileRecord.id]) continue;

			// TODO: better handling of aggressive duplicate prevention

			if (
				!fileRecord.title || fileRecord.title === "" ||
				!fileRecord.filename_download || fileRecord.filename_download === "" ||
				!fileRecord.type || fileRecord.type === ""
			) {
				console.log("FILES: source file has invalid data:%o", fileRecord);
				// throw(`FILES: source file has invalid data:${fileRecord}`);
				continue;
			}

			const existingFileFilter = {
				'title': {'_eq': fileRecord.title},
				'filename_download': {'_eq': fileRecord.filename_download},
				'type': {'_eq': fileRecord.type},
			};
			const existingFile = await apiV9.get(
				"/files",
				{
					params: {
						filter: {
							filename_download: fileRecord.filename_download,
							title: fileRecord.title,
							// description: fileRecord.description
						}
					},
				},
			);
			let importedFileId;
			// console.log('FILES: existing file check result:%o', existingFile);
			const migratedFiles = existingFile.data.data
			// console.log('FILES: existing file check returned data:%o', migratedFiles);
			let fileAlreadyCreated = false;
			if (existingFile.status === 200 && migratedFiles.length >= 1) {
				if (migratedFiles.length === 1){
					const migratedFile = migratedFiles[0]
					// console.log('FILES: found existing migrated file for %s, migrated id %s', fileRecord.id, migratedFile.id)
					context.fileMap[fileRecord.id] = migratedFile.id;
					importedFileId = migratedFile.id;
					fileAlreadyCreated = true;
					// Heuristic to avoid doing field-level update later:
					if (migratedFile.folder !== null)
						continue;
				} else {
					console.log('FILES: ERROR, found %o multiple existing migrated files for %s, %s',
						migratedFiles.length,
						fileRecord.id,
						fileRecord.filename_download,
					);
					continue;
			}
				// continue;
			}

			task.output = fileRecord.filename_download;
			// let url;  // URL to fetch file on source Directus instance
			// if (fileRecord.data.asset_url) {
			// 	url =
			// 		process.env.V8_URL +
			// 		"/" +
			// 		process.env.V8_PROJECT_NAME +
			// 		"/" +
			// 		fileRecord.data.asset_url.split("/").slice(2).join("/");
			// } else {
			// 	url = fileRecord.data.full_url;
			// }

			if (!context.fileMap[fileRecord.id]) {
				// TODO: not sure if this is clean for an arbitrary V9 instance
				// TODO: switch based on Directus version
				const url = process.env.V8_URL + "/assets/" + fileRecord.id
				// console.log('ROB: attempting import with url=%s', url)
				const savedFile = await apiV9.post("/files/import", {
					url,
					data: {
						filename_download: fileRecord.filename_download,
						title: fileRecord.title,
						description: fileRecord.description,
					},
				});
				// console.log('FILES: upload result:%o', savedFile);
				if (savedFile.status !== 200) {
					console.log("FILES: ERROR importing file:%o", savedFile);
					continue;
				} else {
					console.log("FILES: imported file for %o", fileRecord.id);
					context.fileMap[fileRecord.id] = savedFile.data.data.id;
				}
			}

			if (context.fileMap[fileRecord.id]) {
				// Perform update to set fields
				// importedFileId = savedFile.data.data.id;
				importedFileId = context.fileMap[fileRecord.id]
				// Targeted updates. Specifically do NOT want to carry over:
				//   embed - this is constructed by the MediaConvert process (per-env)
				//   filename_disk - this is assigned by the storage layer during import (per-env)
				let importedFileData = {
					"folder": fileRecord.folder,
					"tags": fileRecord.tags,
					"width": fileRecord.width,
					"height": fileRecord.height,
					"metadata": fileRecord.metadata, // TODO: do we want this?
				};
				// console.log('ROB: updating with data:%o', importedFileData);
				const updatedFile = await apiV9.patch(
					`/files/${importedFileId}`,
					importedFileData,
				);
				// console.log("FILES: file update response=%o", updatedFile);
			}
			// context.fileMap[fileRecord.id] = savedFile.data.data.id;
		}
	};
}
