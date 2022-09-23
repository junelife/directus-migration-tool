import Listr from "listr";
import { apiV8, apiV9, sourceIsV8 } from "../api.js";
import { writeContext } from "../index.js";
import { commandLineOptions } from "../index.js";

export async function migrateUsers(context) {
	return new Listr([
		{
			title: "Downloading Roles",
			skip: (context) => context.completedSteps.roles === true,
			task: downloadRoles,
		},
		{
			title: "Creating Roles",
			skip: (context) =>
				commandLineOptions.users === false ||
				context.completedSteps.roles === true,
			task: createRoles,
		},
		{
			title: "Saving Roles context",
			skip: (context) => context.completedSteps.roles === true,
			task: () => {
				context.section = "roles";
				writeContext(context);
			},
		},
		{
			title: "Downloading Users",
			skip: (context) => context.completedSteps.users === true,
			task: downloadUsers,
		},
		{
			title: "Creating Users",
			skip: (context) =>
				commandLineOptions.users === false ||
				context.completedSteps.users === true,
			task: createUsers,
		},
		{
			title: "Saving users context",
			skip: (context) => context.completedSteps.users === true,
			task: () => {
				context.section = "users";
				writeContext(context);
			},
		},
	]);
}

async function downloadRoles(context) {
	const response = await apiV8.get("/roles");
	context.roles = response.data.data.filter((role) => {
		// Directus V8 includes a Public role with id 2 which must be excluded.
		// Directus V9 does not include a Public role in the response,
		// so all roles are included.
		return !(sourceIsV8() && (role.id === 2));
	});
}

async function createRoles(context) {
	const rolesV9 = context.roles.map((role) => (
		(sourceIsV8()) ? {
		name: role.name,
		icon: "supervised_user_circle",
		description: role.description,
		ip_access: role.ip_whitelist,
		enforce_tfa: !!role.enforce_2fa,
		admin_access: role.id === 1, // 1 was hardcoded admin role
		app_access: true,
	} : {
		name: role.name,
		icon: role.icon,
		description: role.description,
		ip_access: role.ip_whitelist,
		enforce_tfa: role.enforce_tfa,
		admin_access: role.admin_access,
		app_access: role.app_access,
	}));

	const createdRoles = await apiV9.post("/roles", rolesV9, {
		params: { limit: -1 },
	});

	context.roleMap = {};

	let createdRolesAsArray = createdRoles.data.data;

	if (Array.isArray(createdRolesAsArray) === false)
		createdRolesAsArray = [createdRolesAsArray];

	context.roles.forEach((role, index) => {
		context.roleMap[role.id] = createdRolesAsArray.find(
			(r) => r.name == role.name
		).id;
	});

	context.roles = createdRolesAsArray;
}

async function downloadUsers(context) {
	const response = await apiV8.get("/users", {
		params: {
			limit: -1,
			status: "*",
		},
	});
	context.users = response.data.data;
	context.userMap = context.userMap || {};
	for (const user of context.users) {
		const v9Response = await apiV9.get(
			"/users",
			{
				params:{
					filter: {
						_or: [
						{first_name: {_eq: user.first_name}},
						{last_name: {_eq: user.last_name}},
						{email: {_eq: user.email}},
					]
				}
				}
			},
		);
		// TODO: check for multiple matches
		const v9Users = v9Response.data.data;
		if (v9Users.length > 0) {
			const v9User = v9Response.data.data[0];
			context.userMap[user.id] = v9User.id;
		}
	}
}

async function createUsers(context) {
	let createdUsersAsArray = [];
	let chunk = [];
	let offset = 0;
	const size = 10;

	do {
		chunk = context.users.slice(offset * size, (offset + 1) * size);

		const usersV9 = chunk.flatMap((user) => {
			if (context.userMap[user.id]) return [];

			return [
				{
					first_name: user.first_name,
					last_name: user.last_name,
					email: user.email,
					title: user.title,
					description: user.description,
					// avatar: user.avatar, @TODO: files first
					language: user.locale,
					theme: user.theme,
					role: context.roleMap[user.role],
					token: user.token,
				},
			];
		});

		offset++;

		if (!usersV9.length) continue;

		const response = await apiV9.post("/users", usersV9, {
			params: { limit: -1 },
		});

		const createdUsers = response.data.data;

		for (const userV8 of chunk) {
			context.userMap[userV8.id] = createdUsers.find(
				(u) => u.email == userV8.email
			).id;
		}

		createdUsersAsArray = createdUsersAsArray.concat(createdUsers);
		await writeContext(context, false);
	} while (chunk.length === 10);

	context.users.forEach((user, index) => {
		if (context.userMap[user.id]) return;

		context.userMap[user.id] = createdUsersAsArray.find(
			(u) => u.email == user.email
		).id;
	});

	context.users = createdUsersAsArray;
}
