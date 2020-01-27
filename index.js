const pgDotTemplate = require('@conjurelabs/pg-dot-template')
const path = require('path')
const fs = require('fs')
const { Pool } = require('pg')

const pool = new Pool()
const transactionSession = Symbol('tracking transaction session within instance')
const withinTransaction = Symbol('queries are within a transaction block')
const beforeQueryHandlers = Symbol('custom before query handlers')
const afterQueryHandlers = Symbol('custom after query handlers')

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

function performFullResponse({ dirPath, filename, instance, getSession }, ...args) {
  return new Promise((resolve, reject) => {
    const template = pgDotTemplate(path.resolve(dirPath, filename))

    let queryString
    try {
      queryString = template(...args)
    } catch(err) {
      return reject(err)
    }

    queryString
      .then(queryString => {
        if (instance[beforeQueryHandlers]) {
          for (let handler of instance[beforeQueryHandlers]) {
            handler({
              query: queryString,
              filename
            }, ...args)
          }
        }

        const session = getSession()
        let query
        try {
          query = queryString.query(session)
        } catch(err) {
          return reject(err)
        }

        query
          .then(result => {
            result.rows = result.rows.map(row => objWithCamelCaseKeys(row))

            if (instance[afterQueryHandlers]) {
              for (let handler of instance[afterQueryHandlers]) {
                handler({
                  query: queryString,
                  filename,
                  result
                }, ...args)
              }
            }

            resolve(result)
          })
          .catch(reject)
      })
      .catch(reject)
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

async function wrapInTransaction(pgDirInstance) {
  const session = { connection: null, keepAlive: true }
  const connection = await onQuery('begin', null, session)

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

      if (prop === 'commit') {
        return () => {
          onQuery()
        }
      }

      return Reflect.get(target, prop)
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

  beforeQuery(handler) {
    if (!this[beforeQueryHandlers]) {
      this[beforeQueryHandlers] = []
    }
    this[beforeQueryHandlers].push(handler)
  }

  afterQuery(handler) {
    if (!this[afterQueryHandlers]) {
      this[afterQueryHandlers] = []
    }
    this[afterQueryHandlers].push(handler)
  }

  transaction() {
    return wrapInTransaction(this)
  }
}

// if `connection` is passed, then .onQuery assumes
// that .release() will be handled manually
function onQuery(queryString, queryArgs, session = {}) {
  const { connection, keepAlive = false } = session

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

pgDotTemplate.onQuery = onQuery
