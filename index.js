const pgDotTemplate = require('@conjurelabs/pg-dot-template')
const path = require('path')
const fs = require('fs')
const { Pool } = require('pg')
const chalk = require('chalk')
const debugQuery = require('debug')('pg-dir:query')
const debugExecuted = require('debug')('pg-dir:executed')

let poolConfig
const privateDirPath = Symbol('privateDirPath')
const privateSession = Symbol('privateSession')

let existingPool
function getPool() {
  if (existingPool) {
    return existingPool
  }
  existingPool = new Pool(poolConfig)
  return existingPool
}

function snakeToCamelCase(name, expr = /_+[a-z]/g) {
  // expecting lower_snake_cased names form postgres
  return name.replace(expr, match => {
    return match.substr(-1).toUpperCase()
  })
}

// mutates an object
// changing keys to camelCase
function objWithCamelCaseKeys(obj) {
  for (let key in obj) {
    let camelCased = snakeToCamelCase(key)
    if (camelCased === key) {
      continue
    }

    obj[camelCased] = obj[key]
    delete obj[key]
  }

  return obj
}

function performFullResponse({ dirPath, filename, session }, placeholders = {}, ...args) {
  return new Promise(async (resolve, reject) => {
    const template = pgDotTemplate(path.resolve(dirPath, filename))

    let queryString, result
    const queryArgs = [placeholders, ...args]
    queryArgs.push(session)

    try {
      queryString = await template(...queryArgs)
    } catch(err) {
      return reject(err)
    }

    debugQuery(chalk.blue(queryString.sanitized))

    try {
      result = await queryString.query()
    } catch(err) {
      return reject(err)
    }

    result.rows = result.rows.map(row => objWithCamelCaseKeys(row))
    resolve(result)
  })
  return template.query(...args)
}

function performQuery(options, ...args) {
  return new Promise((resolve, reject) => {
    performFullResponse(options, ...args)
      .then(response => {
        resolve(response.rows)
      })
      .catch(reject)
  })
}

function performOne(options, ...args) {
  return new Promise((resolve, reject) => {
    performQuery(options, ...args)
      .then(rows => {
        resolve(rows[0])
      })
      .catch(reject)
  })
}

function performQueryToHash(options, key, ...args) {
  return new Promise((resolve, reject) => {
    performFullResponse(options, ...args)
      .then(response => {
        const hash = response.rows.reduce((hash, row) => {
          hash[ row[key] ] = row
          return hash
        }, {})
        resolve(hash)
      })
      .catch(reject)
  })
}

function queryPassthrough(options) {
  function query(...args) {
    return performQuery(options, ...args)
  }

  query.one = function one(...args) {
    return performOne(options, ...args)
  }

  query.fullResponse = function fullResponse(...args) {
    return performFullResponse(options, ...args)
  }

  query.hash = function(key) {
    return function(...args) {
      return performQueryToHash(options, key, ...args)
    }
  }

  return query
}

module.exports = class PgDir {
  // !!! reads dirs synchronously
  // so, this will block, while doing so
  // this is intentional, since `constructor`
  // does not yet support await
  constructor(dirPath, withinTransaction = false) {
    this[privateDirPath] = dirPath
    this[privateSession] = { client: null, keepAlive: withinTransaction }

    const directoryDirents = fs.readdirSync(dirPath, { withFileTypes: true })

    if (withinTransaction) {
      this.begin = () => {
        debugQuery(chalk.blue('begin'))
        return handleQuery('begin', null, this[privateSession])
      }

      this.commit = () => {
        this[privateSession].keepAlive = false
        debugQuery(chalk.blue('commit'))
        return handleQuery('commit', null, this[privateSession])
      }

      this.savepoint = name => {
        const command = `savepoint ${name}`
        debugQuery(chalk.blue(command))
        return handleQuery(command, null, this[privateSession])
      }

      this.rollback = name => {
        if (!name) {
          this[privateSession].keepAlive = false
        }
        const command = name ? `rollback to ${name}` : 'rollback'
        debugQuery(chalk.blue(command))
        return handleQuery(command, null, this[privateSession])
      }
    }

    for (let dirent of directoryDirents) {
      if (!dirent.isFile()) {
        continue
      }

      const nameParts = path.parse(dirent.name)

      if (nameParts.ext !== '.sql') {
        continue
      }

      const nameKey = snakeToCamelCase(nameParts.name, /[_-]+[a-z]/g)

      this[nameKey] = queryPassthrough({
        dirPath,
        filename: dirent.name,
        session: this[privateSession]
      })
    }
  }

  get transaction() {
    return new PgDir(this[privateDirPath], true)
  }
}

module.exports.usingPoolConfig = config => {
  poolConfig = config
  existingPool = null
}

// if `client` is passed, then .handleQuery assumes
// that .release() will be handled manually
function handleQuery(queryString, queryArgs, session) {
  return new Promise(async (resolve, reject) => {
    const pool = getPool()
    let result, err

    if (!session.client) {
      try {
        session.client = await pool.connect()
      } catch(connErr) {
        return reject(connErr)
      }
    }

    debugExecuted(queryString, queryArgs)
    
    try {
      result = await session.client.query(queryString, queryArgs)
    } catch(tryErr) {
      err = tryErr
    } finally {
      if (!session.keepAlive && session.client) {
        session.client.release()
        session.client = null
      }
    }

    if (err) {
      return reject(err)
    }
    resolve(result)
  })
}

pgDotTemplate.handleQuery = handleQuery
