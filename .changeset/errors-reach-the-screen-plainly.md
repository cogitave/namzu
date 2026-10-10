---
"@namzu/desktop": patch
---

Errors in Namzu Desktop read as one plain sentence with a next step, and the original text sits behind Details. A model or engine list that a change of model overtook is read again instead of showing "The conversation settings changed while loading" and leaving the model button on "Not available". Choosing a folder that no longer exists says "That folder no longer exists. Choose another folder." and opens no blank tab. A restored tab of a project whose folder is gone shows that project's own page (its name, Locate folder, Remove project) and no banner. Attachment errors name the file and the limit ("“big.txt” is 6 MB. Choose a file under 3 MB.") and every size is written as "12 KB" or "1.2 MB", never KiB or MiB. A Pal that was created but could not open says so with Retry and Details, and no longer shows the welcome that asks for a name.
