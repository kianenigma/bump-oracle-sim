This is a simulation for a new version of what the pallet located in `../` (`pallet-staking-async-price-oracle`) is
doing.

You don't have to read any other code in this repo for now, and just focus on building a price-oracle simulation for me
with the following description.

High level, we want to use our validators to influence the price. Onchain, we store the latest know price: `LastPrice`.

In each block, all validators submit transactions that are merely a
statement of `Enum Nudge { Up, Down }` -- So they nudge the price up or downwards depending on what they see. They
calculate this by looking at the `LastPrice` and querying an HTTP endpoint to gather their own opinion. These statements
are like transactions that are making it into the block.

At the end of the block, the block author has the option to chose any of nudges
that are already submitted, and based on that change the price. In other words, all of the nudges that are submitted by
other validators limits how much `Up` or `Down` the current validator can push the price.

The current validator would query the real price, and then select the right number of `Nudge` instances that are enough
for the price to go to the right value. Each instance of `Nudge` is multiplied by a system-wide parameter `Epsilon`.
For example, if the block author picks 3 `Nudge::Up` from the ones submitted block, the price changes by `3 * Epsilon` upwards.

## Analysis Requirements

### PseudoCode


```typescript
enum Bump {
	Up,
	Down
}

class Chain {
	// public
	block: number
	// public
	lastPrice: number
	// public
	epsilon: number
	// private
	unprocessedBumps: Bump[]
	// private
	validators: ValidatorAgent[]

	/// We assume fixed 6s block time
	currentTime(): number { this.block * 6000 }

	nextBlock() {
		// all this.validators call `produceBump`
		// pick a random validator as author.
		// give the author all bumps, use their return value as bitmask to activate the nudges.
		// filter nudges by those who are active in the bitmask. Reduce them by cancelling out the ones that are opposite to each other.
		// multiply the remaining nudges by `epsilon` and add to `lastPrice` (add or subtract depending on nudge direction)
		// clean up `unprocessedBumps`
		// inc `block`
	}
}

/// What a validator can do, regardless of them being honest or dishonest.
interface ValidatorAgent {
	/// ref to the chain.
	chain: Chain
	/// Each validator must have an endpoint from which it can get the price. Explained below.
	endpointPrice(): number

	/// Each validator can be the one who produces a new price. It will receive all the bumps, and give the bitmask of active nudges to be used.
	producePrice(bumps: Bump[]): bool[]

	/// Each validator can also be the one who produces a bump.
	produceBump(): Bump
}

/// I don't know the typescript code for this, but with the above base-class for a validator, we can have:
class HonestValidator {
	// endpointPrice: given to us in constructor
	// onchainPrice: given to us in constructor
	// producePrice: call `endpointPrice`, read `chian.LastPrice`, pick the right number of bumps such that the bumps multiplied by `epsilon` mutates `chain.lastPrice` to become `endpointPrice`. Return the corresponding bitmask
	// produceBump: call `endpointPrice`, read `chian.LastPrice`, chose the right direction
}

class MaliciousValidator {
	// you get the point..
}

```

### Safety

I believe we can analyze this with such a framework:

At each block:
* Is the block author malicious?
* What percentage of the `Nudge` transactions were malicious?

I want to conclude from this simulation that as long as no more than a threshold of validators are dishonest, the system
will converge to the right price.

We shall have two main agent types here:

* Validators (all of those who submit `Nudge`)
* Author (one of the validators -- who picks from the `Nudge`s based on its view on the price)

Both agents have access a `Chain` object which will contain crucially our `LastPrice`, and a `nudges: Nudge[]`.
Both agents have access to a function which gives them the price of DOT. This an analogue to them calling an HTTP
endpoint of an exchange. I should be able to wire this to the function that will return the actual price of DOT which we
will download in the next section. I also should have an easy helper function that will add a degree of randomness or
jitter to the real price. So for example all validators will get a slightly different price, but it still all revolves
around the true price.


I want the easy ways to express:
* block author:
  * Is always honest

### Epsilon

I need to find and download the historical price of DOT with high accuracy (every 6s would be great). Then we need to
simulate our system under different safety conditions to see how fast it can react to price changes that DOT has so far
experienced.

First explore what websites and APIs provide us with such high precision price of DOT. This can help:
`example_price-fetch.py`

Then write simulations in which we are fully honest, and run the entire previous history of DOT, so we can figure out
with


### Language

Use typescript and Bun
Use diagram libraries to draw a chart of the real price and our calculated price. It should be in a zoom-able SVG
format.
