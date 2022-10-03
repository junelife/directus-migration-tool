import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

// TODO: Subclass from something in axios. Will allow these new methods to do
//       away with an api argument, etc.

const apiV8 = axios.create({
	baseURL: process.env.V8_URL + "/" + process.env.V8_PROJECT_NAME,
	headers: {
		Authorization: `Bearer ${process.env.V8_TOKEN}`,
		Cookie: `directus-${process.env.V8_PROJECT_NAME}-session=${process.env.V8_COOKIE_TOKEN}`,
	},
});

apiV8.interceptors.response.use(
	(response) => response,
	(error) => {
		const err = /**@type {import('axios').AxiosError}*/ (error);
		throw Error(`
    V8 =>
    ${err.config.url}
    ${err.config.params}
    ${JSON.stringify(err.config.params, null, 4)}
    V8 <=
    ${err.response.status}
    ${JSON.stringify(err.response.data, null, 4)}
    `);
	}
);

const apiV9 = axios.create({
	baseURL: process.env.V9_URL,
	headers: {
		Authorization: `Bearer ${process.env.V9_TOKEN}`,
	},
});

// apiV9.interceptors.response.use(
// 	(response) => response,
// 	(error) => {
// 		const err = /**@type {import('axios').AxiosError}*/ (error);
// 		throw Error(`
//     V9 =>
//     ${err.config.url}
//     ${err.config.params}
//     ${JSON.stringify(err.config.params, null, 4)}
//     V9 <=
//     ${err.response.status}
//     ${JSON.stringify(err.response.data, null, 4)}
//     `);
// 	}
// );

// TODO: disabling this interceptor, as it significantly interferes with
// TODO: implementing meaningful exception handlers by hiding data available
// TODO: in thrown Axios error.
// apiV9.interceptors.response.use(
// 	(response) => response,
// 	(error) => {
// 		const err = /**@type {import('axios').AxiosError}*/ (error);
// 		throw Error(`
//     V9 =>
//     ${err.config.url}
//     ${err.config.params}
//     ${JSON.stringify(err.config.params, null, 4)}
//     V9 <=
//     ${err.response.status}
//     ${JSON.stringify(err.response.data, null, 4)}
//     `);
// 	}
// );

function sourceIsV8() {
	if ((process.env.V8_VERSION === undefined) || (process.env.V8_VERSION < 9)) {
		return true;
	} else {
		return false;
	}
}

async function postIgnoringDuplicates(api, url, data, params) {
	// TODO: handle non-array case
	for (var complete = false; !complete;) {
		try {
			let response = await api.post(
				url,
				data,
				params,
			);
			// console.log('Call to url %s succeeded with response:%o', url, response);
			complete = true;
		} catch (error) {
			// TODO: handle error cases other than these
			const skipErrors = ['RECORD_NOT_UNIQUE', 'INVALID_FOREIGN_KEY']
			for (const err of error.response.data.errors) {
				if (skipErrors.includes(err.extensions?.code)) {
					const errorField = err.extensions?.field;
					data = data.filter((datum) => {
						const errorValue = err.extensions?.invalid;
						const requestValue = datum[errorField];
						return !(datum[errorField] === errorValue);
				})}
			};
			continue;
		}
	};
	return data;
}

async function getCount(api, url) {
	let count_params = {
		limit: 0,  // This works at least for V9
		meta: "total_count",
	}
	const count = await api.get(url, {params: count_params});
	return count.data.meta.total_count;
}

async function downloadBatch(api, url, page) {
	// return async (context, task) => {
	const records = await api.get(url, {
		params: {
			offset: page * 100,
			limit: 100,
			// when fetching from UUID-based collections,
			// unsorted not returning all data with pagination.
			sort: 'id',
		},
	});
	return records.data.data;
	// }
}

export { apiV8, apiV9, sourceIsV8, postIgnoringDuplicates, getCount, downloadBatch };
