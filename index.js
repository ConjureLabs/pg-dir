const pgDotTemplate = require('@conjurelabs/pg-dot-template')
const path = require('path')
const fs = require('fs')

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

function performFullResponse(template, ...args) {
  return new Promise((resolve, reject) => {
    let query
    try {
      query = template.query(...args)
    } catch(err) {
      return reject(err)
    }

    query
      .then(result => {
        result.rows = result.rows.map(row => objWithCamelCaseKeys(row))
        resolve(result)
      })
      .catch(reject)
  })
  return template.query(...args)
}

function performQuery(template, ...args) {
  return new Promise((resolve, reject) => {
    performFullResponse(template, ...args)
      .then(response => {
        resolve(response.rows)
      })
      .catch(reject)
  })
}

function performOne(template, ...args) {
  return new Promise((resolve, reject) => {
    performQuery(template, ...args)
      .then(rows => {
        resolve(rows[0])
      })
      .catch(reject)
  })
}

function queryPassthrough(template) {
  function query(...args) {
    return performQuery(template, ...args)
  }

  query.one = function one(...args) {
    return performOne(template, ...args)
  }

  query.fullResponse = function fullResponse(...args) {
    return performFullResponse(template, ...args)
  }

  return query
}

module.exports = class Sql {
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

      this[nameKey] = queryPassthrough(pgDotTemplate(path.resolve(dirPath, dirent.name)))
    }
  }
}
