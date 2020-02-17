# pg-dir

this module exports a class that uses [pg-dot-template](https://github.com/ConjureLabs/pg-dot-template/) to fill in templatized sql files, and provides some nicities to query and use data.

## install

```sh
# peer dependency
npm install pg

# this module
npm install @conjurelabs/pg-dir
```

## use

see [the node postgres docs](https://node-postgres.com/) on setting up your database connection.

once `pg` is connected, then store you `.sql` files in a directory and initialize `PgDir` to start querying.

### directory setup

_./sql/accounts/get-account.sql_
```sql
select *
from accounts
where id = $PG{id}
limit 1;
```

_./sql/accounts/create-account.sql_
```sql
insert into accounts (first_name, last_name, type, email, added)
values (!PG{firstName}, !PG{lastName}, $PG{type}, !PG{email}, now())
returning *;
```

_./sql/accounts/index.js_
```js
const PgDir = require('@conjurelabs/pg-dir')

module.exports = new PgDir(__dirname)
````

### normal queries

an instance of `PgDir` will expose camel-cased filenames, allowing you to query each easily

__index.js__
```js
const accountsSql = require('./sql/accounts')

async function main() {
  const accounts = await accountsSql.getAccount({
    id: 123
  })

  console.log(accounts[0])
  // row keys are camel-cased
  /*
    {
      id: 123,
      firstName: 'Timo',
      lastName: 'Mars',
      type: 'admin',
      email: 'timo@mars.somesite',
      added: '2020-01-20T23:04:00.250Z'
    }
   */
  
  // `firstName`, `lastName` and `email`
  // will log '<REDACTED>' to console
  // but will pass actual values to postgres
  // (due to using `!PG{...}`)
  //
  // `type` will show 'user' in console
  // and will pass 'user' to postgres
  // (due to using `$PG{...}`)
  await accountsSql.createAccount({
    firstName: 'timoteo',
    lastName: 'marshall',
    type: 'user',
    email: 'timoteo@marshall.museum'
  })
}
await main()
````

### .one()

often you will only want a single row

```js
const account = await accountsSql.getAccount.one({
  id: 123
})
```

### .hash(key)

a common pattern is to pull rows and have them stored in a lookup hash, by specific key

```js
const accounts = await accountsSql.getAllAccounts.hash('email')({
  limit: 10
})
// returns { [email]: <row> }
```

### .fullResponse()

if you need to access the full postgres response object, you can use `.fullResponse`

```js
const accountsResponse = await accountsSql.getAccount.fullResponse({
  id: 123
})
const account = accountsResponse.rows[0]
```

### custom template handlers

`$PG{name}` can be used to replace values, and `!PG{name}` can be used to replace while redacting values from console logs.

these will only work in a postgres `where` clause

see [the pg-dot-template docs' section on expression handlers](https://github.com/ConjureLabs/pg-dot-template#postgres-expression-handlers) to see more.

### transactions

`pg-dir` adds utility methods for dealing with `begin`, `commit` and `rollback` (transaction blocks)

```js
const transaction = await accountsSql.transaction

try {
  // triggers `begin` query
  await transaction.begin()

  const newAccountRow = await transaction.createAccount.one({
    firstName: 'timoteo',
    lastName: 'marshall',
    type: 'user',
    email: 'timoteo@marshall.museum'
  })

  await transaction.createAccountLogin({
    accountId: newAccountRow.id
  })

  // triggers `commit` query
  // then attempts connection.release()
  await transaction.commit()
} catch(err) {
  // triggers `rollback` query
  // then connection.release()
  await transaction.rollback()

  console.error(err)
}
```

you can also create savepoints, and rollback to these savepoints

note that if you rollback to a savepoint the sql pool connection will not be released

```js
await transaction.savepoint('some_point')

// do something else

await transaction.rollback('some_point')
```

### console logging

logging is built in - this library uses the [debug](https://www.npmjs.com/package/debug) module

```sh
DEBUG="pg-dir:query" node ./
```

this will log all queries _before_ they are executed, and these logs will be sanitized on non-development environments

```sh
DEBUG="pg-dir:executed" node ./
```

this will log queries as they are executed, with **no sanitization**

the exact query being passed to `pg`, along with an array of arguments for placeholder values, will be logged
