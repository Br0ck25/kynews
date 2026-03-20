**[FIXED — Change 62, 2026-03-20]** This article was tagged Kentucky, Hancock and Scott County.  
Expected: Kentucky only (statewide legislation — Senate Concurrent Resolution 172).  
Root cause: `isStatewideKyPoliticalStory` did not recognize "Senate Concurrent Resolution" as a statewide trigger. "Georgetown" (quoted ophthalmologist's city) was mapped to Scott County. Fix: added Concurrent/Joint Resolution detection to `isStatewideKyPoliticalStory`.

https://kentuckylantern.com/2026/03/20/gop-lawmaker-seeks-comprehensive-review-of-ky-optometrists-oversight-practice-scope/

Government
Health
Politics
GOP lawmaker seeks ‘comprehensive review’ of KY optometrists’ oversight, practice scope
Senate Health Services chair proposes task force after Lantern revealed that licensing board waived exams for some recent graduates
By:
Deborah Yetter
-
March 20, 2026
11:08 am

 Sen. Stephen Meredith, R-Leitchfield, said his proposed task force would help inform lawmakers about changes that might be needed in Kentucky’s oversight of optometrists in time for next year’s session of the General Assembly. (LRC Public Information)

Oversight of Kentucky’s 900 optometrists and their licensing board would be examined by a task force under a resolution in the state Senate.

The resolution, filed March 18 by Sen. Stephen Meredith, R-Leitchfield, comes after the disclosure last year, first reported by the Kentucky Lantern, that the state Board of Optometric Examiners had  improperly granted licenses to some optometrists who had not passed one or more parts of the required three-part national exam.

Among 21 optometrists who had licensure requirements waived was the daughter of former board president Dr. Joe Ellis, a prominent Kentucky optometrist who resigned abruptly in December amid growing questions about the board’s licensure practices.



Meredith’s Senate Concurrent Resolution 172 calls for a “comprehensive review” of the scope of practice of optometrists — one of the broadest in the country — as well as licensure requirements and the makeup of the board, which currently consists of five members appointed by the governor — four optometrists and one consumer representative.

Meredith, chairman of the Senate Health Services Committee, said he hopes a task force will help focus the issue and provide a guide for lawmakers if legislative changes are needed. While he has been critical of some of the board’s past actions, he said he wants time to gather information before the General Assembly next meets in 2027.

“Everyone needs to have a voice in this,” he said. “There’s no sense in rushing it. I want everybody to be heard.”

The task force would include members of the General Assembly, optometrists — who hold a four-year doctorate of optometry — medical doctors including ophthalmologists, and representatives from Kentucky’s medical schools and the University of Pikeville’s College of Optometry, the state’s only optometry school. It is to meet monthly and submit its findings to legislators by Oct. 31.

“I’m looking forward to a good work group,” Meredith said.

However, the Kentucky Optometric Association prefers letting a proposed work group of experts complete its work before “deciding if a task force is necessary,” said president Dr. Hannah Huffman.  


Dr. Mary Beth Morris (Deborah Yetter)
Dr. Mary Beth Morris, a Hancock County optometrist who became president of the examiners’ board in February, said in an email that public protection is the board’s top priority.

The board “acknowledges that some of its regulations and processes would benefit from input from individuals and entities not currently serving on the board,” she said in an email statement. “As a result, (the board) has been working with legislators to create a workgroup that includes outside individuals and entities to thoroughly review such things as the credentialing standards and future advancements in eye care technology.”

The Kentucky Academy of Eye Physicians and Surgeons, which represents medical doctors who specialize in eye treatment, said it supports the task force.

The organization “ is committed to the eye health of Kentuckians. We embrace any discussion that will strengthen laws and regulations that ensure patient safety, which is our paramount concern,” Jamie Bloyd, executive director, said in a statement.

But Dr. William “Chip” Richardson, a Georgetown ophthalmologist and former president of the academy, said he had hoped for a change in state law requiring stricter oversight of optometrists after a state attorney general’s opinion last year found the optometry board violated state law by waiving licensure requirement for some applicants.



The opinion found the board acted improperly between 2020 and 2023 by approving a series of waivers of licensure requirements or allowing “alternative testing.” While the board has the authority to set licensure standards it must make changes by enacting public regulations rather than through internal votes or resolutions, it said.

Richardson said creating a task force puts off addressing key issues including whether optometrists granted waivers hold valid licenses, a question also raised by the attorney general’s opinion.

The board has given any affected optometrists until 2027 to complete required exams though it decided to restrict laser eye surgeries they may perform until they meet licensure standards.

“I fear that it’s delaying the solution, which puts the public at risk for another year,” Richardson said in an email. “We have seen a continuous pattern of inadequate actions from the optometry board.”

Richardson also criticized as misleading a letter the optometry board has sent to all legislators seeking to correct what it describes as “inaccurate or misleading information.”

The letter, signed by Morris, the board president, cites several examples of “myths” including the claim that optometrists licensed through waivers do not hold a valid license.

The attorney general “never stated these individuals have invalid licenses,” the letter said.

Richardson disagrees.

The attorney general found that the board exceeded its authority in waiving requirements for licensure and that its actions were “null, void and unenforceable,” Richardson said.

“This is a finding that the board granted licenses it had no legal authority to issue,” he said. “You can call that a ‘myth’ if you want. The law calls it something else.”



**[FIXED — Change 63, 2026-03-20]** This was tagged Kentucky and Fayette County; should be Kentucky only.  
Root cause: "HB 500" (bill abbreviation) did not trigger the statewide bill check, and "across the Commonwealth" / "all 120 counties" were not statewide signals. Fayette County was applied via `lex18.com` source default. Fix: extended bill regex to match `HB/SB/HR/SR \d+` and added "across the Commonwealth", "all N counties" to the statewide-suffix check.

https://www.lex18.com/news/covering-kentucky/kentucky-state-budget-change-could-force-the-shutdown-of-dolly-partons-imagination-library-program
Kentucky state budget change could force the shutdown of Dolly Parton's Imagination Library program
Dolly Parton
Britainy Beshear
Andy Beshear
Photo by: Timothy D. Easley/AP
Dolly Parton, left, speaks with Brittany Beshear, center, and Kentucky Governor Andy Beshear to celebrate the expansion of the Imagination Library of Kentucky at the Lyric Theatre in Lexington, Ky., Tuesday, Aug. 27, 2024. The library is now available to all 120 counties of Kentucky and provides books to children up to the age of 5 free books. (AP Photo/Timothy D. Easley)
	By: Erin Rosas
Posted 8:40 AM, Mar 20, 2026 and last updated 9:44 AM, Mar 20, 2026
LOUISVILLE, Ky. (LEX 18) — The latest version of the Kentucky state budget could effectively wipe out Dolly Parton's Imagination Library Program in the state, a book-gifting initiative that has mailed 8,635,423 free books to Kentucky children.

Every month, the program mails an age-appropriate book to children from birth to age 5 at no cost to families. A local partner in each county enrolls children and raises money to pay for the books. Support from the entertainer and her foundation brings the cost down to less than $3 per book, including postage. However, that amount can still be challenging for local partners to raise.

In 2021, leaders of both parties in the Kentucky Senate led an effort to add state funding, matching local partners dollar-for-dollar, a release from program representatives read. With the state match in place, the program expanded across the Commonwealth. Today, every child in Kentucky is eligible to receive books until their 5th birthday.

The latest version of Kentucky's primary budget bill under consideration, HB 500, could change that. As passed by the Kentucky Senate, the bill provides the full $2.5 million that would fund the dollar-for-dollar match, but it changes the formula so the state would only cover one-third of the cost of the books.

Dolly Parton
KY House Committee advances resolution to expand Dolly Parton's book program
The change would keep thousands of dollars from reaching local partners, creating a burden many could not meet, according to a news release. Both larger counties with thousands of eligible children and small rural communities with limited fundraising opportunities would face imminent closure.

Libby Suttles is the Executive Director of Imagination Library of Kentucky.

"When we surveyed our local program partners, more than 80 percent said they’d expect to shut down in less than a year under this new funding formula," Suttles said. "With so much focus on kindergarten readiness, we don’t understand why anyone would shut down a program that’s proven to work, especially when it doesn’t free up any money in the budget."

The budget bill now heads back to the Kentucky House, where leaders from both parties will work to resolve differences between their respective versions of the bill, including the funding for the book program.

"We hope families who have loved the books will contact their legislators and ask them to restore the funding to the formula that’s set out in state law," Suttles said. "This is a small investment with an incredible return for the future of our children."

The program now delivers books to more than 138,000 children across the state each month. Recent data from the Kentucky Department of Education shows the percentage of students who were kindergarten ready was as much as 13 points higher among children who participated in the program.

**[FIXED — Change 63, 2026-03-20]** This was tagged Kentucky and Floyd County; should be Kentucky only.  
Root cause: "Senate Bill 40" matched the bill regex, but "heads to governor" (in title) and "Having passed both the House and Senate, SB 40 now awaits consideration by the governor" (in body) were not in the statewide-suffix check — so the bill branch fell through without returning true. Floyd County entered via Readability sidebar bleed. Fix: added "heads to governor", "awaits governor", "passed both chambers" to the statewide-suffix check.

https://www.owensborotimes.com/news/2026/03/boswells-bill-shifting-library-board-appointments-to-local-control-heads-to-governor/
Boswell’s bill shifting library board appointments to local control heads to governor
By Ryan RichardsonMarch 20, 2026 | 12:14 amUpdated March 20, 2026 | 12:39 am
boswell
Sen. Gary Boswell, R-Owensboro, speaks on Senate Bill 40 on the Senate floor. | Photo by David Hargis, Public Information Office, Legislative Research Commission.

Share
Tweet
Print
Legislation sponsored by Sen. Gary Boswell that would move appointment authority for public library boards to local officials has cleared both chambers of the Kentucky General Assembly and is headed to the governor’s desk.

Senate Bill 40 shifts the authority to appoint library board members from the state back to the local level. The bill applies to county library districts and permits a county judge-executive, with Fiscal Court approval, to fill board vacancies without being required to consider recommendations from the library board or the state librarian if the county has adopted an alternative appointment process.

Boswell has long pushed for the move, saying it allows communities to manage appointments through their own processes. He said the measure addresses delays caused by existing procedures, which can leave library boards with prolonged vacancies.

“Relying on proximity means libraries better represent their communities,” Boswell said. “This legislation improves governance by returning decision-making authority to the local level and giving counties greater responsibility over library board appointments.”

Boswell said the bill has support from the Kentucky County Judge/Executive Association and the Kentucky Department for Libraries and Archives. Advocates say a community-based approach will improve transparency and accountability while preserving day-to-day library operations.

Having passed both the House and Senate, SB 40 now awaits consideration by the governor.

