# Implementation details

This document attempts to describe this tool in slightly more depth than [readme.md](readme.md)

## General Approach

This tool attempts to copy over data from a source Directus instance to a target Directus instance.
The original version was written to also remap data to address breaking changes in the Directus models between V8 and V9.

The general approach is to:

1. Fetch data from the source Directus instance.
2. Upload to the target Directus instance in a deliberate manner:

   - Add data one collection at a time, in an order that does not violate Directus nor underlying database constraints.  Specifically, populating collections on the "one" side of relationships before the "many" collection so that their foreign key relationships have integrity.
   - Update any references to Directus `files` by modifying the `id` field to use the new `id` assigned during the preceding import step.  A map is kept in the application `context.fileMap`, which is populated prior to importing any application collections.
   - Similarly, an attempt is made to set the creating user.  TODO: IS THIS TRUE??????

### V9 to V9 Migrations

Some additional work has been done to make this tool capable of migrating data from a V9 instance to another V9 instance.
This is primarly:

- Allow specification of a variable in the `.env` file, `V8_VERSION`.  Setting it to a numeric value 9 or greater will trigger this.  Ideally, these environment variables (and the `V9_*` ones as well) would be renamed to something like `SOURCE_*` and `TARGET_*` to better express their meaning.
- Adjusting the schema acquisition process to fetch data from the V9 Directus system tables where it differs.
- Simplification in a few places to copy data directly instead of remapping.

## Scope

### Out of Scope

As mentioned in the [readme.md](readme.md), many things are NOT migrated by this tool, including:

- Interface/display configurations
- Permissions
- Activity / revisions

## Processing Flow

The tool has a significant amount of data that is shared globally via a `context`.  This context is written out occassionally to files under the local `context/state` folder.

Important: although this data is persisted to local storage, the process is not written in such a way that it is simple to resume a previous failed run.  This would be nice to have, but would take some additional engineering time to do well.

The general steps that the migration tool follows are:

### Context Initialization

This task initializes the shared `context` object.  It currently does this by loading the contents of an existing `context/start.json` file which simply marks all the tasks as not yet completed.

There is a command line switch (`--useContext`) which can load this context from a different file.  But, no guidance on use cases for this.  It does seem to load this single context file specified by this option.  But, the other json files that make up the full persisted context do not appear to be read (perhaps this an exercise left to the reader, to build this full file).

It also sets an item in the context, `context.allowFailures` based on a CLI option.
// TODO: investigate and document, as this did NOT seem to really work for me.

### Relations Fetch

This task consists of fetching relations data from the source Directus instance.  It is stored in `context.relationsv8`.

### Schema Fetch

This task consists of fetching schema data from the source Directus instance.  It is stored in `context.collections`.
If the source instance is V8, all of the collection and field data comes from the `/collections` endpoint.
For V9, data from `/collections` must be augmented with data retrieved from the `/fields` endpoint.

The collections included in this fetch may be filtered with CLI or .env settings.

### Schema Migration

This is an optional task which can be requested on the command line (`--schema`).  It will construct the collections retrieved during `Schema Fetch` ( which are stored in `context.collections` ).

Check on this!!!

### User/Role Migration

This task will copy existing roles and users from the source Directus instance to the target.

It will not attempt to copy the `Public` role.
Permissions on collections for roles will also not be copied.
TODO: But, this may be changed for us.

When users are copied:

1. An attempt is made to identify any existing user of the same name/email in the target instance, and will skip if present.
2. Some fields not copied to new user: `avatar` (this seems to be because `files` have not yet been migrated), `token` (this is good).
3. The new user is created with the same `id` as the source.
4. A `context.userMap` object is created to allow lookup of the new user based on the source user id.  This may be useful if there is a collision on the source user id (TODO).

### Relations Migration

This task stores collection relationship details in the target Directus instance.  It is also an optional task (TODO: finish this description)

### File Migration

This consists of two tasks, and is optional, enabled by specifying the `--files` option on the command line.

1. Folder migration - creating file folders with the same name and id as in the source.
2. File migration - this is more complicated.

This work is performed by a set of concurrent tasks migrating batches of files from source to target.  A file upload is performed using the `/files/import` endpoint, which has a couple of implications:

a. The upload will work for very large files, as the target Directus server pulls the file using a URL, instead of being a multi-part POST.
b. The `id` for the migrated file cannot be specified ( not part of the `/files/import` API ).  So, a mapping of source to target file `id` is stored in `context.fileMap`

### Data Migration

This is an optional step, enabled by specifying the `--data` command line option.

It uploads a copy of all records in selected collections to the target Directus instance.  The collections migrated are determined by one of:

1. Using one or more `--skipCollections` CLI options ( or a single list in a `SKIP_COLLECTIONS` .env setting )
2. Using one or more `--onlyCollections` CLI options ( or a single list in a `ONLY_COLLECTIONS` .env setting )
3. Barring the presense of either of the above options, ALL collections will be migrated.

In order to avoid violating relational integrity constraints, related collections must be migrated in the correct order.  The script attempts to do this automatically by examining relationships and inserting the collections on the "one" side of a relationship first.  If, for whatever reason, this does not work, there is an optional .env setting, `COLLECTION_ORDER`

Much like the file migration, migration of a collection is done in a set of concurrent tasks migrating batches.  There is a priming query done to determine the record count, then the individual batches do paginated fetches from the source Directus instance.
