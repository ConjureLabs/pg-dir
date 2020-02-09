const pgDotTemplate = require('@conjurelabs/pg-dot-template')
const path = require('path')
const fs = require('fs')
const { Pool } = require('pg')
const debug = require('debug')('pg-dir')

const pool = new Pool()
const transactionSession = Symbol('tracking transaction session within instance')
const withinTransaction = Symbol('queries are within a transaction block')

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

function performFullResponse({ dirPath, filename, getSession }, ...args) {
  return new Promise(async (resolve, reject) => {
    const template = pgDotTemplate(path.resolve(dirPath, filename))
    const session = getSession()

    let queryString, result
    const queryArgs = [...args]
    queryArgs.push(session)

    try {
      queryString = await template(...queryArgs)
    } catch(err) {
      return reject(err)
    }

    debug(queryString)

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

  return query
}

function proxiedTransactionInstance(pgDirInstance) {
  // values set during lifecycle
  const session = { connection: null, keepAlive: false }

  return new Proxy(pgDirInstance, {
    get: (target, prop) => {
      // disallow nested transactions
      if (prop === 'transaction') {
        return undefined
      }

      // marking instance as within a transaction
      if (prop === withinTransaction) {
        return true
      }

      if (prop === transactionSession) {
        return session
      }

      if (prop === 'begin') {
        return () => new Promise((resolve, reject) => {
          session.keepAlive = true
          handleQuery('begin', null, session)
            .then(resolve)
            .catch(reject)
        })
      }

      if (prop === 'commit') {
        return () => new Promise((resolve, reject) => {
          handleQuery('commit', null, session)
            .then(result => {
              session.connection.release()
              session.keepAlive = false
              resolve(result)
            })
            .catch(reject)
        })
      }

      if (prop === 'rollback') {
        session.keepAlive = false
        return () => handleQuery('rollback', null, session)
      }

      return Reflect.get(target, prop)
    },

    ownKeys: target => {
      const ownKeys = Reflect.ownKeys(target)
      ownKeys.splice(ownKeys.indexOf('transaction'), 1)
      ownKeys.push('commit')
      ownKeys.push('rollback')
      return ownKeys
    },

    has: (target, prop) => {
      if (prop === 'transaction') {
        return false
      }
      if (prop === 'commit' || prop === 'rollback') {
        return true
      }
      return prop in target
    }
  })
}

module.exports = class PgDir {
  // !!! reads dirs synchronously
  // so, this will block, while doing so
  // this is intentional, since `constructor`
  // does not yet support await
  constructor(dirPath) {
    const directoryDirents = fs.readdirSync(dirPath, { withFileTypes: true })

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
        instance: this,
        getSession: () => this[transactionSession]
      })

      this[withinTransaction] = false
      this[transactionSession] = null
    }
  }

  get transaction() {
    return proxiedTransactionInstance(this)
  }
}

// if `connection` is passed, then .handleQuery assumes
// that .release() will be handled manually
function handleQuery(queryString, queryArgs, session) {
  session = session || {}
  let { connection, keepAlive = false } = session

  return new Promise(async (resolve, reject) => {
    let result, err

    if (!connection) {
      try {
        connection = await pool.connect()
      } catch(connErr) {
        return reject(connErr)
      }
    }

    session.connection = connection
    
    try {
      result = await connection.query(queryString, queryArgs)
    } catch(tryErr) {
      err = tryErr
    } finally {
      if (!keepAlive) {
        connection.release()
      }
    }

    if (err) {
      return reject(err)
    }
    resolve(result)
  })
}

pgDotTemplate.handleQuery = handleQuery
