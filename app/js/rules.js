/* Rules & Philosophy: the standards the drafts in this app are written against,
   and the ones you review them by. Read-only reference, shown from the Rules
   button in the top bar. Story and test-case generation prompts are written
   to follow these rules. */
(function () {
  'use strict';
  const title = 'Rules & Philosophy — what guides creation in this app';
  const markdown = `*Read-only reference. These are the standards the drafts in this app are written against, and the ones you review them by.*

## 1. The 4 Agile values

- **Individuals and interactions** over processes and tools.
- **Working software** over comprehensive documentation.
- **Customer collaboration** over contract negotiation.
- **Responding to change** over following a plan.

*There is value in the items on the right; we value the items on the left more.*

## 2. The 12 Agile principles

1. **Satisfy the customer** through early and continuous delivery of valuable software.
2. **Welcome changing requirements**, even late; change is a competitive advantage.
3. **Deliver working software frequently**, from a couple of weeks to a couple of months, favoring the shorter scale.
4. **Business people and developers work together** daily throughout the project.
5. **Build around motivated individuals.** Give them the environment and support they need, and trust them to get the job done.
6. **Face-to-face conversation** is the most efficient and effective way to convey information.
7. **Working software is the primary measure of progress.**
8. **Sustainable development.** Sponsors, developers and users should be able to maintain a constant pace indefinitely.
9. **Continuous attention to technical excellence** and good design enhances agility.
10. **Simplicity**, the art of maximizing the amount of work not done, is essential.
11. **Self-organizing teams** produce the best architectures, requirements and designs.
12. **Reflect and adjust.** At regular intervals the team reflects on how to become more effective, then tunes its behavior accordingly.

## 3. INVEST: what a good story looks like

| Letter | Quality | The one-line test |
|:---:|---|---|
| **I** | Independent | Can it be built and tested on its own? |
| **N** | Negotiable | Is the detail still open to conversation, rather than fixed like a contract? |
| **V** | Valuable | Does a user or the business notice when it ships? |
| **E** | Estimable | Can the team size it without guessing? |
| **S** | Small | Does it fit comfortably inside one iteration? |
| **T** | Testable | Could someone prove it is done with a clear pass/fail check? |

## 4. Definition of Ready

A story is ready to be picked up when:

- [ ] It states who wants what and why (**As a… I want… so that…**).
- [ ] It passes the **INVEST** checks above.
- [ ] **Acceptance criteria** are written, one per line, and each one is verifiable.
- [ ] The requirement(s) it covers are linked (\`REQ-nnn\`).
- [ ] Dependencies and open questions are named, with an owner for each.
- [ ] Priority is set and the team has sized it.
- [ ] A reviewer has read it and agrees it is understood.

## 5. Definition of Done

A story is done when:

- [ ] Every **acceptance criterion** is met, and demonstrated rather than asserted.
- [ ] Its **test cases** are written, traced to the requirement, and have been run.
- [ ] No open defects at blocking severity; any remaining ones are triaged and recorded.
- [ ] Code is reviewed and merged, and the build is green.
- [ ] Non-functional needs that apply (performance, security, accessibility, audit) are checked.
- [ ] Documentation and the requirement-level report are updated.
- [ ] The result is saved and approved by a human reviewer.

## 6. Test-case quality rules

1. **One objective.** A case proves one thing; its title says what.
2. **Preconditions stated.** Role, data, environment and configuration are named, not assumed.
3. **Clear numbered steps.** Each step is a single action someone else could repeat exactly.
4. **Unambiguous expected result.** Specific values, codes and messages, so any two reviewers reach the same pass or fail.
5. **Requirement traceability.** Every case carries the \`REQ-nnn\` it proves, so each requirement ends with a verdict.
`;
  window.Rules = { title, markdown };
})();
