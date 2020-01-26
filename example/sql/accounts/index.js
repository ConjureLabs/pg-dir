const PgDir = require('@conjurelabs/pg-dir')

const sql = new PgDir(__dirname)

// logging queries
sql.afterQuery((args) => console.log(args.query))

module.exports = sql
