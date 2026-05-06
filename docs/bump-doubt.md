I want to take a step back in a week or two once my time clears up to re-evaluate the design myself again.

I started my design with this high level design space:

In any oracle system, we need to decide on 3 things:

Who provides the input data
What that input date is
Who aggregates the inputs into the final oracle value

and I find it a great way to think about this system.

No one disputes the former: It should be the validators.

On the second, a nudge is a subset of the information that the actual price conveys. It could be defensible that the system doesn't need to know the actual price, and a nudge is enough. Providing the actual price is a superset of what a nudge conveys. We can have a 100% identical system in which signed nudges are in fact signed price, and the runtime still interprets them as a nudge multiplied by epsilon if it wishes to.

I find the last one the hardest to accept. In our design, the validators, taking turn, are wearing this hat, while an alternative would be to let the runtime do this (an initial design was already made on this basis that also works).

If all validators are honest, the two systems are strictly equal.
If some validators are dishonest, our current design seems strictly worse than just letting the chain aggregate the data, depending on how that aggregation would be. In a simple median computed by the runtime + absolute price submitted by validators, the final price would be the same as if 49% of the validators were malicious, while in the nudge based design with 49% malicious, while we loosely follow the real price, our error rate is already quite high
The only benefit of our 3rd current design decision (let validators aggregate) is if we assume validators will actively modify their offchain code (which they are free to do), and come up with their own creative and good ways to aggregate the data, and if a minority of validators go malicious, they actively start to ignore them. But even if all honest majority validators do all of that (which in all honestly it is unlikely they do), we still give the turn to the dishonest minority to alter the price as they wish.

The other disadvantage related tot he second choice is also that we lose any useful information related to slashing. If we have absolute prices, and we keep track of them, we can measure the distance between each individual price submitted and final price, and calculate a "score/confidence" for each validator. If a validator is consistently and grossly far from the final price, their confidence can be decreased, they can be disabled, and they can be slashed, all automatically. And none of this is possible with nudges.
