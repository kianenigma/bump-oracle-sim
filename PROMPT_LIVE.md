Read the @CLAUDE.md, @README.md and get an overview of this project. Make sure the documentation is updated as you learn more

What we are doing here is simulating an oracle deisgn for Polkadot's validators with different mechanisms for them to reach consensus.

OUr best option atm is latched median, keep this in mind

What is currently under-represented here, is what _each validator would do internally_, and we call this the Mini Oracle:


A teammate who is rather junio has come up with  @Mini Oracle Design.md. I think it is a  good start, but it needs to be tested further. In this doc, we ONLY want to focus on The CEX only aggregation method

To test this, I watn you to take this @Mini Oracle Design.md as input, and:

* research exactly what APIs are available, in exchanges with reasonable reputation and trading volume (we already use 5, which you can find in @src/data/trades/venues/, you can add more if needed) tha tcan be use in a live fashion. For example now we dump all trades and we use it to backfill a simulation. But we want to know the endpoints that are available live
* Use this data to propose a plan that fits the @Mini Oracle Design.md (with adjustments if you prefer) to createa  "Live" version of our oracle sim: It will run our selected method and configs (latched oracle + 30 validators by default) LIVE, and use the same trading view UI as the infrastructure to display it. Similar to our current UI, our UI should have the ability for you to show, for each block, what exactly happened -- what each validator submitted, what was the updated price onchain, etc.
