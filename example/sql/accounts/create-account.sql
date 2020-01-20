insert into accounts (first_name, last_name, type, email, added)
values (!PG{firstName}, !PG{lastName}, $PG{type}, !PG{email}, now())
returning *;
