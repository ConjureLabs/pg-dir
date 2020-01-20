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

