const pgDotTemplate = require('@conjurelabs/pg-dot-template')
const path = require('path')
const fs = require('fs')
const { Pool } = require('pg')

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

function performFullResponse({ dirPath, filename, instance }, ...args) {
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

        let query
        try {
          query = queryString.query()
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
        instance: this
      })
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
}

module.exports.setup = () => {
  const pool = new Pool()

  pgDotTemplate.setup({
    query: async (...args) => {
      const connection = await pool.connect()
      return new Promise(async (resolve, reject) => {
        let result, err
        
        try {
          result = await connection.query(...args)
        } catch(tryErr) {
          err = tryErr
        } finally {
          connection.release()
        }

        if (err) {
          return reject(err)
        }
        resolve(result)
      })
    }
  })
}
