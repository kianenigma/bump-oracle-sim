# SMOLDOC

# SMOLDOC

This document is the set of writeups about the price-oracle system of Polkadot. The latest specification of the system can be found [here](). For the rest of the tabs, some act as auxiliary pages:

* [Simulation]()
* [Price API research]()
* [All oracle incidents on rekt.news]()

While the rest are archived and relate to different design variations discussed.

# Final Design

# Polkadot Price Oracle

Author: [Kian Paimani](mailto:kian@parity.io)
Status: Final
Date: Apr 21, 2026

# Problem

Multiple systems in the Polkadot ecosystem, most notably pUSD, need a reliable price feed to function correctly. This is a standard oracle problem, in which the chain needs to conclude what is the value pertaining to some information in the real world, in this case the price of DOT:USD. While doing so, we don’t want to rely on any centralized oracle-as-a-service, and solely rely on fully decentralized processes, in-line with Polkadot’s philosophy. Moreover, for good or bad, Polkadot ecosystem does not natively have access to any DEXs with deep liquidity to deduce a decentralized price for there.

# Solution

This leaves us with roughly one direction left to go: Use our validator set to create a price oracle, similar to what we do for timestamps. Yet, we still need to answer the question of:

* What ***inputs*** validators provide to the chain? The actual price, or something else?
* How will the chain ***interpret*** those ***inputs*** to conclude a new price?

**Inputs.** To limit the amount of influence that each validator may have on the system, we replace a validator’s ability to say “the price is $X” with just an expression of “the price is higher/lower”.

**Interpretation of the inputs.** Then, we have two options for interpreting those inputs, and conclude a new price.

* The chain's runtime decides the new price
* Each validator takes turn in deciding the new price (inherent model)

Our simulations have shown that the system is very resilient to corruption of validators to a high extent (49% to be precise) if we go with the latter. Moreover, this is a protocol-level acknowledgement that the price is ultimately a subjective matter, and no single function can be written once to determine it.

## High Level Specification

With the above in mind, the system can be described as follows:

* The core data-type of the system is an `Enum Nudge { Up, Down }`, and a configuration stored on the runtime `E` (epsilon). Each nudge is multiplied by the epsilon upon evaluation.
* The relay chain validators will, on a regular basis, query the runtime for the assets for which a price is needed, and the suggested HTTP endpoints that should be used to query them.
* Each validator will query (all or some of) the endpoints associated with each asset, and compare it with the latest onchain price. Based on this, they conclude if the price should go `Up` or `Down`.
* Validators will propagate signed statements with their `Up/Down`, and gossip it to other nodes.
* Each block author has the opportunity to provide a list of signed nudges to the runtime as an inherent.
  * They compute this with a similar process as above: See the actual onchain price, compare it with their local opinion of the price, select enough nudges to move the price towards their local opinion
* The runtime multiplies the net provided nudges (where each up and down cancel each other), after checking their correctness, with the epsilon and produces a new price.
* The new price lives on the Polkadot relay chain, and can easily be propagated from there onwards.

## Detailed Specification

The above section provided a high level description of the system. We can now iterate over further details of this flow.

**Nudge Signing.** A signed nudge by a validator will contain a signature over the validator signing it, the BABE slot, the asset-pair identifier (decided by the runtime) and the `Nudge` enum.

**Signing Keys.** For simplicity, the BABE signing keys are reused to sign the nudges. This alleviates the need for validator nodes to register a new session key, and beyond slightly ergonomics of it, poses no real downside.

**Inherent Inclusion.** A switch storage item in the runtime should dictate if a block without an inherent is valid or not, per asset-pair. This can be used to enact a harder enforcement on validators always including the inherent.

**Runtime Validation.** The runtime, upon receiving the inherent, will validate it in full. Per asset-pair:

* All signatures are checked to be correct, and pertain to the current validator set
* All signed asset-pair identifiers are correct
* The minimum number of nudges is respected (0 indicates even 0 nudges is valid)
* The signed slot is not too old
* Each validator is only present once
* In case of any of the above failing, the runtime may choose to return an error but accept the block, or panic, rendering the block as invalid.
  * The former can be used in a testing period until we are confident that the node side code is correct and always produces the valid inherent.
  * In any case the inherent logic in the node code is assumed to always produce a valid inherent.

**Endpoints And Parsing.** There are significant downsides with hardcoding the list of endpoints in the node side, such as inflexibility to add/remove an endpoint, and to support a new asset. Instead, we employ a 2 step process in which:

* The node’s inherent code will ask the pallet (via a runtime API – see below) what the asset-pairs are present, and what are the endpoints that are *suggested* for each of them
* The node will query the endpoints
* To parse each HTTP response, the node will again ask the pallet for decoding

This design enables a few key benefits:

* New endpoints can be added solely via a runtime upgrade, without needing any validator node software upgrade
* In case of an endpoint being compromised, a faster onchain governance call can disable it for all complying nodes.
* The runtime may encode the parsing logic for a wide range of APIs, but only select a subset of them as *enabled* to the node.

Needless to say, the node side’s inherent code is solely outside of the runtime, and a validator is free to alter it. This is why in the above, we should interpret this as a runtime’s *suggested* endpoints. In reality, the runtime has no way to verify if a signed nudge was produced with these suggested endpoints or not. This is merely an assistance from the runtime to the node’s inherent code.

**Inherent Price Calculation.** While the above sections leaves it open for the node to utilize one or all of the endpoints per asset-id, the default node side implementation should fetch all endpoints, choose a random one, and query that one. The randomness chosen here should not be the onchain randomness, ensuring different validators will choose different endpoints at the same timepoints.

**Incentivization.**  Making the inherent mandatory is the ultimate incentive mechanism for this system, forcing all validators to participate. Yet, as a softer method, the `price-oracle` pallet should have the ability to also associated era reward points to validators providing valid inherents.

With this, we can highlight the main interfaces of the `price-oracle` pallet on the relay chain runtime:

```rust
/// The identifier of an asset pair (a u8 or u32).
use sp_price_oracle::{PairId, EndpointId};

#[pallet::config]
pub trait Config: frame_system::Config {
	/// Hook called when the price is updated. Set to `()` if unused.
	type OnPriceUpdate: OnPriceUpdate<BlockNumberFor<Self>>;
}

/// Configuration of each asset-pair.
pub struct PairConfig {
	/// Minimum number of nudges that must be present in an inherent of the
	/// key-ed `PairId`.
	min_nudges: u32,
	/// Number of slots for which a nudge related to the key-ed `PairId` is valid.
	nudge_validity: u64,
	/// Whether the inherent of the key-ed `PairId` is mandatory to be included in
/// the block or not.
///
	/// If `true`, a fully valid inherent is checked to exist onchain `on_finalize`.
	///
	/// Defaults to `false`
	inherent_mandatory: bool,
	/// Whether an error in [`Pallet::submit_nudges`] related to the key-ed
/// `PairId` should panic, or return an error.
	/// An errored inherent still counts towards `inherent_mandatory`.
	///
	/// Defaults to `false`
	invalid_inherent_panics: bool,
	/// Epsilon value of this pair.
	epsilon: FixedU128;
}

/// All asset-pairs.
#[pallet::storage]
pub type Pairs = StorageMap<_, PairId, PairConfig>;

/// Endpoints currently active for each asset-pair, used to fulfill the runtime-api below.
///
/// This should be mapped to an enum that stores all possible parsing methods for a single asset.
#[pallet::storage]
pub type ActiveEndpoints = StorageMap<_, PairId, Vec<EndpointId, Vec<u8>>>;

/// Whether we have seen an inherent related to the key-ed `PairId` in this block or not.
#[pallet::storage]
pub type InherentSeen = StorageMap<_, PairId, bool>;

#[pallet::call]
pub fn submit_nudges(origin: OriginFor<T>, pair_and_nudges: (PairId, Vec<SignedNudge>)) -> DispatchResult {
	ensure_none(origin)?;
	// Note: we have to do this, instead of multiple inherents, because each instance
	// of each INHERENT_IDENTIFIER can be seen just once per block (FRAME assumption).
	for (pair, nudges) in pair_and_nudges {
		let config = Pairs::get(pair_id);
		InherentSeen::<T>::insert(pair_id, true);
		// rest of checks, erroring or panicing based on `invalid_inherent_panics`
	}
}

#[pallet::hooks]
fn on_finalize(_: _) {
	for (pair_id, PairConfig { inherent_mandatory, .. } in Pairs::<T>::iter() {
		if inherent_mandatory && !InherentSeen::take(pair_id) {
			panic!("Inherent must be included but was not seen")
		}
	}
}
```

And the runtime APIs that are needed for this system to work:

```rust
/// Identifier for an endpoint within an asset pair. Only used to keep the
/// Runtime and node in-sync between `endpoint_list` and `decode_results`.
type EndpointId = u8;

/// Identifier for an asset-pair.
type PairId = u8;

/// An asset-pair, with a list of endpoints.
type PairWithEndpoints = (PairId, Vec<EndpointId, Vec<u8>>)

sp_api::decl_runtime_apis! {
	/// Runtime API for the price oracle.
	pub trait PriceOracleApi {
		/// Get the current on-chain price (0 if not yet set).
		fn current_price(id: PairId) -> FixedU128;

		/// Get the epsilon value (absolute price change per net nudge).
		fn epsilon(id: PairId) -> FixedU128;

		/// Get the nudge validity window in slots.
		fn nudge_validity(id: PairId) -> u64;

		/// Get the current set of BABE authorities.
		fn authorities() -> Vec<AuthorityId>;

		/// Get the minimum number of nudges required to update the price.
		fn minimum_nudges_required(id: PairId) -> u32;

		/// Get all asset-pairs and their endpoints.
		fn endpoint_list() -> Vec<PairWithEndpoints>;

		/// Batch-decode raw HTTP response bodies into prices.
		///
		/// Return value is ordered exactly as the input is.
		fn decode_results(data: Vec<PairWithEndpoints>) -> Vec<(PairId, Vec<Option<FixedU128>>)>;
	}
}
```

# Simulation Results

See [here]().

# Risks

## Operation Risks

* **Weight usage.** Per asset, we might be verifying validator\_count signatures onchain inside the inherent. This could pose a risk to the weight limits of the chain.
  * **Mitigation.** The existing benchmarks for verifying a signature over a host call shows that 600 signature checks would consume [around 2%](https://github.com/paritytech/polkadot-sdk/blob/c3a902187711f0081c37eefa50da420124e29e1c/substrate/frame/benchmarking/src/weights.rs#L178-L187) of the block weight.
* **Decimal Error**: A rather simple, but very much plausible error. This can happen at two stages:
  * When the JSON response of an API is being parsed
  * When the price is being parsed by AH and other consumers.
  * **Mitigation.** Audit upon integration. The decimal points of pUSD and DOT are unlikely to change, if we get it right once.
* **Endpoint Risks:**
  * **Manipulation with capital:** Similar to an AMM, if one of our APIs is backed by a shallow market, a small amount of capital is enough to skew the price
  * **DOS:** The endpoint can be DOS-ed to not respond in time
  * **Format Change:** The endpoint’s response format might change, rendering it useless at best (if we simply cannot parse the response) or harmful (if we parse it into a wrong number) at worst. The latter is a border case of the first case of the decimal parsing errors above.
  * **Malicious.** In the worst case, the owners of an API might collude with an attacker to manipulate the price.
  * **Mitigations:**
    * We limit ourselves to high-quality, reliable, and high volume endpoints. See [the endpoint study]() for more details and examples.
    * We use a diverse set of endpoints, and validators’ default behavior is choosing a random endpoint.
    * No validator can submit a price, but rather an Up/Down. Our [simulation shows](#49%,-50%) that the system is fairly resilient up to 33% of validators submitting wrong nudges, and still retains roughly the right price up to 49%. Only at 50% the price has significantly diverged. This means half of our list of endpoints should be taken down for this.

## Implementation Risks  {#implementation-risks}

* **JAM Incompatibility.** This design, implemented in the above form factor, adds a slim pallet to the RC runtime, and new offchain processes to the RC validator node software. It is therefore not JAM compatible.
  * **Mitigations:**
    * There is an idea to synchronize RC validators and AH collators in the meta-node project. Yet, this goes head-to-head with Polkadot’s sharded execution model. **This mitigation is therefore invalid**.
    * In any future, with or without JAM, Polkadot validators have to run additional offchain services that will fulfill roles such as the SSS. One of such services has to be a rewritten version of this oracle process. The signed nudges in this case are directly sent to the parachain service, and is integrated in the AH runtime directly.

# Alternatives Considered

* **Oracle Hub Parachain with absolute price submission.** Ruled out due to the complexity of launching a new chain, and outsized influence of validators by submitting a price vs. Nudge. [Design]() here.
* **Oracle Hub with this inherent-based protocol.** Ruled out due to the complexity of launching a new chain. [Comparison table]() here.
* **This inherent-based protocol directly on AH collators.** Ruled out due to smaller collator set size of AH compared to the RC.
* **This inherent-based protocol where signed nudges are produced by RC validators, but are directly sent over the wire to AH collators:** Ruled out due to complexity in the short term, and because it still imposes a rewrite once RC as we know it is sunset in favor of JAM (see [JAM incompatibility](#implementation-risks) above).

# Future Work

## The Bigger Picture

The simulation framework has a process in place to determine the optimal epsilon based on various parameters. Yet, we have not yet decided on one because no grand simulation of the current oracle, with pUSD, DAP and the larger system has been done. This should be the next step of this effort, beyond the implementation.

## pUSD Oracle \!= Polkadot Oracle

The system described here can be defined as the “Polkadot Native Oracle”, but it doesn’t mean that it should be the final oracle that pUSD will use. The final pUSD oracle can either work as a layered system, or triangulate multiple systems. The options are as follows:

* Paid oracle systems, partnership with enterprise systems like Chainlink
* Fetch price from a Hydration DEX
* Fetch price from an Ethereum DEX

Similar to the above point, more research on the e2e price flow in conjunction with the rest of the system is needed before final conclusions about the pUSD oracle (not necessarily what is discussed here) and its parameters and circuit breakers can be made.

## Connecting to the gossip network

It would be very useful if a standalone software, operated by Parity/fellowship, can connect to the P2P network of validators, and listen to the nudges being gossiped.

## Ban Inefficient Inherent

The final price update is the net sum of nudges, multiplied by the epsilon. As in, the following two are equal:

* 5 nudges up, 6 nudges down: epsilon down
* 1 nudge down: epsilon down

We may prohibit the former, and enforce the set of nudges to be in the most compact possible way. This might clash with the min\_nudge feature envisioned above, but the min\_nudge is a speculative simple feature, and I don’t strictly see it being even used.


# OH \- Oracle Hub

Authors: [Kian Paimani](mailto:kian@parity.io) with special thanks to [George Pisaltu](mailto:george.pisaltu@parity.io) for his inspirational initial design and feedback.

# TL;DR

Multiple systems in Polkadot need to know the accurate price of DOT against other assets (primarily USD). The main use-case for this is vaults in a stable-coin system, such as pUSD. In-line with the rest of services on Polkadot, we aim to leverage the same validator set to provide (aka. *oraclize*) information about the price of the system, and the system to conclude a final price from this information. This final price is then used in the rest of the system. For scalability reasons, this system will run on a single-core parachain, Oracle Hub (OH for short).

# Problem

Most existing oracles rely on either of the two approaches:

* Tap into an AMM DEX to determine the price
* Rely on a somewhat trusted set of nodes to provide price information to the chain. These nodes could be in:
  * The worst case small trusted set
  * A stake-backed group of validators with more credible trust behind them, similar to Chainlink

In our Polkadot solution, other than obviously not being a centralized system, we also don’t want to rely on any third party chain/token/governance. This rules out options such as using the price from Hydration’s AMM DEX, or relaying using Uniswap/Chainlink price via Snowbridge/Hyperbridge.

# Proposed Solution {#proposed-solution}

## High Level Description

Therefore, we will use a similar approach to that of Chainlink, utilizing the existing Polkadot validators to oraclize the price information. To prevent spamming the relay/AH chain, we will deploy a new system parachain called Oracle Hub, in which all of the collators are automatically synchronized with the relay chain validators. Moreover, no entities other than the collators are permitted to submit any transaction to OH. Collators submit frequent price updates (aka. **votes**) to the OH. OH will regularly **tally** these votes to conclude a new **price** from it. The price is then propagated to AH via an XCM.

## Detailed System Description

#### Validator Propagation

Validators of the Polkadot relay chain (RC) are today elected on AH, and sent to the RC. We extend this process such that the RC will automatically, upon activating a new validator set, sends the stash keys of its validators to OH. These stash keys need to be associated with 2 custom session keys on the OH to perform two tasks:

* **Aura key** for block production – **The same relay validators will be the collators of OH**.
* **Oracle key** for sending vote transactions. These keys are stored in the keystore, and are accessible to the Offchain Worker (OCW) process. The OCW will use the Oracle session key to send signed vote transactions back to the chain. This is discussed further in the following sections.

#### Runtime Restrictions

**Local Transactions.** The OH runtime is extremely restricted. It does not have the balance/transaction-payment pallet, and prevents any signed transactions, other than the ones signed by the designated collators. Moreover, it employs the Operational dispatch class for all oracle-related transactions, ensuring that even if a bug allows spamming of this chain by non-collators, the votes can be cast with a dedicated weight budget.

**XCM.** The OH runtime’s XCM configuration should be configured such that the chain can be upgraded as with other system chains, yet disallows any user related teleporting, or remote XCM call dispatching in this chain.

#### Voting in OCW

**OCW \+ Signed Transactions.** As noted above, we use the polkadot-sdk’s built-in OCW to cast votes. OCWs are separate threads, automatically executed by the collator upon import of each block import, and have access to HTTP request primitives, which they use to fetch the latest price. Moreover, the OCWs will send their votes as ordinary signed transactions, leveraging the existing tx-pool and gossiping machinery of polkadot-sdk.

**Endpoints and fetching the price aka. Vote**. The OCW process reads a list of API endpoint metadata from the chain’s state. Using this metadata, it will know what lists of APIs are available for each asset pair, and how they should be queried[^5]. On each block, for each asset-pair, the OCW will select a random endpoint, query it, parse the response, and submit the result back to the chain. This result is called a vote, and is a raw FixedU128 number. Endpoints are therefore sensitive information, and should be modified only by governance/fellowship. The parsing method of each specific API therefore needs to be hardcoded in the OCW code.

#### Manager Binary

A secondary binary will be provided to the validators running the OH collators. This binary has two main purposes:

* It can insert specific values into the dedicated OCW database. This can be used for a number of use-cases, such as:
  * Insert a value in the special kill-switch key, force disabling the OCW (without needing to restart the validators with a new flag)
  * Insert premium API keys to be used privately by the OCW
* It can mimic the API querying, parsing, and tx-submission. This can be used in conjunction with the kill-switch mentioned above to disable the hardcoded OCW at times when an urgent code-fix is needed. See the [first open question](#open-questions) about how the manager binary complements the OCW.

#### Vote Validity and Priority

**T::MaxVoteAge.** A cast vote transaction also includes the block-number from which it was generated. Moreover, the oracle has a MaxVoteAge parameter. This allows the runtime to use this information in at least 2 areas.

* Upon tx-pool validation, votes older than MaxVoteAge are considered invalid. This can be checked either by a custom tx-extension, or by setting a voluntary mortality on the transaction. The same check repeats upon actual dispatch
* If a tally fails, we can optionally keep the votes that are still valid with respect to MaxVoteAge. This is discussed in the [Tally](#tally) section.

**Priority.** Votes with more recent block number take higher priority in the tx-pool. This ensure that if a previous OCW has submitted a vote, it has not yet been included, and a more recent OCW now has a new vote, the newer one takes precedence. Note that in this scenario both vote transactions have the same nonce, and only one can be included. Inclusion of either will invalidate the other one. This is achieved with a custom transaction extension.

#### Tally {#tally}

At the end of each block (**on\_finalize**), the runtime gathers all votes that are not yet processed and are still valid, and passes them on to a configurable Tally (**T::Tally::tally(votes)**). The result is then either a concluded price, or an error (**TallyError**) which also signifies the pallet to:

* **YankVotes:** Erase all votes that were used in this unsuccessful tally
* **KeepVotes:** Keep the votes that still adhere to MaxVoteAge, and use them for an upcoming Tally

**Rationale.** At this stage, We are not sure if a 300/600 collator OH can propagate all 300/600 transactions within the timespan of a single block or not. Moreover, we don’t yet know what threshold of all validators are sufficient to consider a tally valid or not. The combination of our MaxVoteAge \+ TallyError allows us to have a flexible system that easily fulfils different scenarios.

#### Duplicate Votes

Votes are always associated with a block number in which they are being processed, a **DoubleMap\<Asset, BlockNumber, BTreeMap\<AccountId, Vote\>\>**. Duplicate votes within the same **BlockNumber** always replace the previous one. They can happen for two reason:

* The same collator happened to have two votes in the same block (unlikely)
* The tally of block N was **Err(KeepVotes)**. In this case, all votes of block N are moved to block N+1. In this case, any of the collators who already voted for N, already has a vote for block N+1, and therefore their new vote will replace the older one.

Please see the implementation draft for more information.

#### History Slashing / Rewarding

The system retains up to **T::HistoryDepth** blocks worth of previous price and voting information. This is intended for two purposes:

* While we generally prefer any averaging and smoothing of the price to happen on AH’s side, it enables OH to also perform these mutations on the price if need be.
* It allows OH to keep a record of which validators have voted, and how much their vote was diverging from the final tally outcome. This information can be effectively used to reward and penalize validators retroactively for their work in OH.

# Scope

**In-Scope.** The main purpose of the OH is to compute a regular price, and propagate it to the rest of the system as soon as possible, with XCM or similar mechanisms. Attached to this price are a timestamp, and RC block-number as a canonical measure of time. The OH might as well attach further metadata about how this price was calculated, signaling a confidence metric, such as:

* How many votes were cast which led this price
* What is the standard deviation of the set of votes that led to this price

In other words, the OH will attempt to notify the rest of the system about the price as early as possible, and in a raw manner.

**Out-of-Scope.** Nonetheless, we refrain within the scope of this project from any further application-specific manipulation of the price, and leave that to the said application.

**pUSD Case.** In the context of pUSD, on AH, in the pallet that receives the price update from OH, we may manipulate the price to:

* Use a time-weight-average (TWAP) – Using the timestamp and RC block-number provided
* Impose a max-price-change based on the final specification of pUSD, which could either smooth the price, or trigger a circuit breaker.

More on this in [pUSD Notes](#pusd-notes) below.

# Risks

### Prelude: Incident Analysis

[Another tab in this document](https://docs.google.com/document/d/1IXRYwXINf0QgetJdgj1q__yCR1MaXjD5_DgPY8wEovY/edit?tab=t.do027ns1ioq3) contains a digest of all oracle-related hacks and failures recorded on rekt.news. They primarily revolve around AMM price manipulation via flash loans, something which we are inherently immune to. Yet, reading it will be quite useful as an introduction to this section.

### Implementation Risks

* **Decimal Error**: A rather simple, but very much plausible error. This can happen at two stages:
  * When the JSON response of an API is being parsed
  * When the price is being sent from OH to AH
* **Endpoint Risks:**
  * **Manipulation with capital:** Similar to an AMM, if one of our APIs is backed by a shallow market, a small amount of capital is enough to skew the price
  * **DOS:** The endpoint can be DOS-ed to not respond in time
  * **Format Change:** The endpoint’s response format might change, rendering it useless at best (if we simply cannot parse the response) or harmful (if we parse it into a wrong number) at worst. The latter is a border case of the first case of the decimal parsing errors above.
  * **Malicious.** In the worst case, the owners of an API might collude with an attacker to manipulate the price.
* **Weight Restrictions:** We perform the tallying on\_finalize with the assumption that processing up to 300/600 votes \+ tally per block is well within the abilities of a parachain with a single core.
  * The fact that we replace duplicate votes is the only spam possibility – The collators themselves are the only entities that can spam the chain. The final system needs a way such that a single bad collator is not enough to spam the chain.

### Operational Risks

* **Slashing:** In the absence of slashing, it is questionable if we can incentivize validators to run the OH collator nodes. We have the foundation of slashing in-place, but the parameterization is yet to be finalized. Lack of proper and strict-enough slashing could exacerbate the next point.
* **Sluggishness:** Even with slashing, large operators in the Polkadot validator set might be slow to react to this change and get their gears in place to run the OH. The polkadot meta-node would have solved this. This poses a risk to the timelines of this project.

### OH’s Security Argument {#oh’s-security-argument}

OH’s security is primarily rooted in two design choices:

* **Validators:** Validators are already trusted parties, with a strong assumption that at least ⅔ thereof are honest. This enables us to not need to rely on either external parties, nor centralized oracles. This in itself nullifies a number of vulnerability classes mentioned [here]().
* **Diverse Endpoints:** Most devastating attacks on existing oracles are done by flash-loaning or manipulating an AMM/Exchange-Pair, especially when the price relies entirely on a single source. We do the opposite: No AMMs are used, and we aggregate many many sources. We rely on a large set of endpoints, provided by companies with different management teams and geopolitical circumstances. Moreover, some of these sources do their own averaging over the market (e.g. CoinLore) vs. relying on an internal exchange pair (e.g. Kraken API). For the latter, we limit ourselves to exchanges that have deep enough liquidity, making price manipulation infeasible. Even if manipulation happens on a single exchange whose API we are using, it will be one faulty data-point among many. We target to have at least a dozen endpoints at launch, if not more. So, for an effective attack, one must hack/manipulate at least ½ of them, increasing the cost of the attack.

# Open Questions {#open-questions}

* What other spam protection mechanism we need to think of to keep OH sanitized?
* Manager Binary vs OCW. The two have different properties.
  * Manager is: flexible (not constrained to WASM bytecode), fast to upgrade, but *we cannot* upgrade it.
  * OCW is exactly the opposite. Rigid, slow to upgrade, but *we can* upgrade it.
  * Our goal is to have both, with OCW being the default. Is this sensible?
* Is slashing enough to enforce validators to run the OH, especially in the absence of the meta-node. What should constitute a slash?
* Endpoints: We have a broad dilemma in selecting endpoints – Aggregated ones (CoinGecko, CMC) are not free, and the CEX ones are free. CEX ones are more prone to price manipulation.
* Should we also remove the nonce tx-extension? It is not needed, and while it enforces some ordering on the votes, it can also invalidate other votes.

# Appendix

## Draft Implementation

See [here](https://github.com/paritytech/polkadot-sdk/pull/10990), and the review notes of the PR description.

![][image5]

## pUSD Notes {#pusd-notes}

The ultimate question for pUSD is to decide on how fast/slow or sharp/smooth its internal price update should be (please see the [Stale Oracle vulnerability class](https://docs.google.com/document/d/1IXRYwXINf0QgetJdgj1q__yCR1MaXjD5_DgPY8wEovY/edit?tab=t.do027ns1ioq3#heading=h.sq4som7kzzs3)). An industry standard is using TWAP. The pros and cons are as follows:

* Smooth/Slow upgrades:
  * Pro: More immune to manipulation and anomalies
  * Buy cheap collateral, protocol values it more:
    * Not good for peg restoration (redemption)
    * You can over-borrow (temporarily)
* Sharp/Fast upgrades:
  * Con: Manipulation/bug more likely to spread
  * Pro: Liquidations are detected fast, less bad debt
  * Pro: Redemptions are more effective

Since we have argued [so far that OH is more resilient to price manipulation than an average Oracle](#oh’s-security-argument), so far I am concluding that **if the pros of a relatively fast/sharp price update is more desirable for peg retention and vault safety, pUSD should not shy away from having sharp price updates**. In other words, while TWAP is the norm in the industry, it is the norm, from an oracle perspective, because most oracles use a single AMM. In other words, TWAP is a defence against flash-loans, which is not possible against our oracle.

The second, related existential question for pUSD is at what level of price change it should trigger a circuit breaker and halt operations. I have not thought deeply about this one yet.

pUSD simulation is the ultimate source of answering both.

## Tentative Ideas

(only listed, as they are explained elsewhere)

* Automatic feed disabling, explained [here](https://docs.google.com/document/d/1IXRYwXINf0QgetJdgj1q__yCR1MaXjD5_DgPY8wEovY/edit?tab=t.xlnharod8p3o#heading=h.2jxmi6awbug3).
* [TEEs](https://docs.google.com/document/d/1IXRYwXINf0QgetJdgj1q__yCR1MaXjD5_DgPY8wEovY/edit?tab=t.xlnharod8p3o#heading=h.x79gaiaqd441)

## Suggested Parameters

TBD

