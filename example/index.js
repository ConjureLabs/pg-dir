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
