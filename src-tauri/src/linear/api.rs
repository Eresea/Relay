//! Small, typed calls to Linear's GraphQL API.

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;

use crate::error::{Error, Result};

const GRAPHQL: &str = "https://api.linear.app/graphql";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Viewer {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub email: String,
    pub organization: Organization,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Organization {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub url_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Team {
    pub id: String,
    pub name: String,
    pub key: String,
    #[serde(default)]
    pub timezone: Option<String>,
    #[serde(default)]
    pub issue_estimation_type: String,
    #[serde(default)]
    pub issue_estimation_extended: bool,
    #[serde(default)]
    pub issue_estimation_allow_zero: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowState {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub team: Option<TeamRef>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamRef {
    pub id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    pub id: String,
    pub identifier: String,
    pub title: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub priority: u8,
    #[serde(default)]
    pub due_date: Option<String>,
    #[serde(default)]
    pub estimate: Option<f64>,
    #[serde(default)]
    pub updated_at: String,
    #[serde(default)]
    pub archived_at: Option<String>,
    pub state: Option<WorkflowState>,
    pub assignee: Option<Person>,
    pub project: Option<ProjectRef>,
    #[serde(default)]
    pub project_milestone: Option<ProjectMilestoneRef>,
    pub cycle: Option<CycleRef>,
    #[serde(default, with = "label_nodes")]
    pub labels: Vec<LinearLabel>,
    pub team: Team,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinearComment {
    pub id: String,
    pub body: String,
    pub created_at: String,
    #[serde(default)]
    pub edited_at: Option<String>,
    pub user: Option<Person>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueDetail {
    pub issue: Issue,
    pub children: Vec<Issue>,
    pub comments: Vec<LinearComment>,
    pub relations: Vec<IssueRelation>,
    pub inverse_relations: Vec<IssueRelation>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueRelation {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub issue: Option<IssueRelationRef>,
    #[serde(default)]
    pub related_issue: Option<IssueRelationRef>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueRelationRef {
    pub id: String,
    pub identifier: String,
    pub title: String,
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Person {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRef {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMilestoneRef {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CycleRef {
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
    pub number: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinearLabel {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub color: Option<String>,
    pub team: Option<TeamRef>,
}

mod label_nodes {
    use serde::{Deserialize, Deserializer, Serialize, Serializer};

    use super::LinearLabel;

    #[derive(Deserialize)]
    struct Connection {
        nodes: Vec<LinearLabel>,
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<Vec<LinearLabel>, D::Error>
    where
        D: Deserializer<'de>,
    {
        Connection::deserialize(deserializer).map(|connection| connection.nodes)
    }

    pub fn serialize<S>(labels: &[LinearLabel], serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        labels.serialize(serializer)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinearProject {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub start_date: Option<String>,
    #[serde(default)]
    pub target_date: Option<String>,
    #[serde(default)]
    pub archived_at: Option<String>,
    #[serde(default)]
    pub status: Option<LinearProjectStatus>,
    #[serde(default)]
    pub lead: Option<Person>,
    #[serde(default, deserialize_with = "deserialize_nodes")]
    pub teams: Vec<Team>,
    #[serde(default, deserialize_with = "deserialize_nodes")]
    pub external_links: Vec<LinearExternalLink>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinearDocument {
    pub id: String,
    pub title: String,
    pub url: String,
    pub updated_at: String,
    #[serde(default)]
    pub content: Option<String>,
    #[serde(default)]
    pub creator: Option<Person>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinearExternalLink {
    pub id: String,
    pub label: String,
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinearProjectResources {
    pub documents: Vec<LinearDocument>,
    pub external_links: Vec<LinearExternalLink>,
}

fn deserialize_nodes<'de, D, T>(deserializer: D) -> std::result::Result<Vec<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    #[derive(Deserialize)]
    struct Connection<T> {
        nodes: Vec<T>,
    }
    Connection::deserialize(deserializer).map(|connection| connection.nodes)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinearProjectStatus {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinearProjectUpdate {
    pub id: String,
    pub body: String,
    pub health: String,
    pub created_at: String,
    pub user: Person,
    #[serde(default)]
    pub archived_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinearMilestone {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub target_date: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinearCycle {
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    pub number: i64,
    #[serde(default)]
    pub starts_at: Option<String>,
    #[serde(default)]
    pub ends_at: Option<String>,
    #[serde(default)]
    pub is_active: bool,
    pub team: Team,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Initiative {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub target_date: Option<String>,
    #[serde(default)]
    pub archived_at: Option<String>,
    #[serde(default)]
    pub projects: Vec<InitiativeProject>,
    #[serde(default)]
    pub updates: Vec<InitiativeUpdate>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitiativeUpdate {
    pub id: String,
    pub body: String,
    pub health: String,
    pub created_at: String,
    pub user: Person,
    #[serde(default)]
    pub archived_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitiativeProject {
    pub id: String,
    pub project: ProjectRef,
}

#[derive(Deserialize)]
struct GraphqlResponse<T> {
    data: Option<T>,
    #[serde(default)]
    errors: Vec<GraphqlError>,
}

#[derive(Deserialize)]
struct GraphqlError {
    message: String,
}

pub async fn viewer(token: &str) -> Result<Viewer> {
    #[derive(Deserialize)]
    struct Data {
        viewer: Viewer,
    }

    Ok(query::<Data>(
        token,
        "query RelayViewer { viewer { id name email organization { id name urlKey } } }",
        json!({}),
    )
    .await?
    .viewer)
}

pub async fn teams(token: &str) -> Result<Vec<Team>> {
    #[derive(Deserialize)]
    struct Data {
        teams: Nodes<Team>,
    }

    Ok(query::<Data>(
        token,
        "query RelayTeams { teams { nodes { id name key timezone issueEstimationType issueEstimationExtended issueEstimationAllowZero } } }",
        json!({}),
    )
    .await?
    .teams
    .nodes)
}

pub async fn users(token: &str) -> Result<Vec<Person>> {
    #[derive(Deserialize)]
    struct Data {
        users: Nodes<Person>,
    }
    Ok(query::<Data>(
        token,
        "query RelayUsers { users(first: 100) { nodes { id name } } }",
        json!({}),
    )
    .await?
    .users
    .nodes)
}

pub async fn issue_labels(token: &str) -> Result<Vec<LinearLabel>> {
    #[derive(Deserialize)]
    struct Data {
        #[serde(rename = "issueLabels")]
        labels: Nodes<LinearLabel>,
    }
    Ok(query::<Data>(
        token,
        "query RelayIssueLabels { issueLabels(first: 250) { nodes { id name color team { id } } } }",
        json!({}),
    )
    .await?
    .labels
    .nodes)
}

pub async fn create_issue_label(
    token: &str,
    name: &str,
    color: &str,
    team_id: Option<&str>,
) -> Result<LinearLabel> {
    #[derive(Deserialize)]
    struct Data {
        #[serde(rename = "issueLabelCreate")]
        result: IssueLabelMutation,
    }
    let mut input = json!({ "name": name, "color": color });
    if let Some(team_id) = team_id {
        input["teamId"] = json!(team_id);
    }
    let data: Data = query(
        token,
        "mutation RelayIssueLabelCreate($input: IssueLabelCreateInput!) { issueLabelCreate(input: $input) { success issueLabel { id name color team { id } } } }",
        json!({ "input": input }),
    )
    .await?;
    data.result.into_value("Linear did not create the label")
}

pub async fn update_issue_label(
    token: &str,
    label_id: &str,
    name: &str,
    color: &str,
) -> Result<LinearLabel> {
    #[derive(Deserialize)]
    struct Data {
        #[serde(rename = "issueLabelUpdate")]
        result: IssueLabelMutation,
    }
    let data: Data = query(
        token,
        "mutation RelayIssueLabelUpdate($id: String!, $input: IssueLabelUpdateInput!) { issueLabelUpdate(id: $id, input: $input) { success issueLabel { id name color team { id } } } }",
        json!({ "id": label_id, "input": { "name": name, "color": color } }),
    )
    .await?;
    data.result.into_value("Linear did not update the label")
}

pub async fn delete_issue_label(token: &str, label_id: &str) -> Result<()> {
    #[derive(Deserialize)]
    struct Data {
        #[serde(rename = "issueLabelDelete")]
        result: DeleteMutation,
    }
    let data: Data = query(
        token,
        "mutation RelayIssueLabelDelete($id: String!) { issueLabelDelete(id: $id) { success } }",
        json!({ "id": label_id }),
    )
    .await?;
    if data.result.success {
        Ok(())
    } else {
        Err(Error::LinearApi("Linear did not delete the label".into()))
    }
}

pub async fn projects(token: &str, include_archived: bool) -> Result<Vec<LinearProject>> {
    #[derive(Deserialize)]
    struct Data {
        projects: ProjectConnection,
    }
    let mut projects = Vec::new();
    let mut after = None;
    loop {
        let data: Data = query(
            token,
            "query RelayProjects($includeArchived: Boolean!, $after: String) { projects(first: 100, after: $after, includeArchived: $includeArchived) { nodes { id name description url startDate targetDate archivedAt status { id name type } lead { id name } teams { nodes { id name key } } externalLinks(first: 100) { nodes { id label url } } } pageInfo { endCursor hasNextPage } } }",
            json!({ "includeArchived": include_archived, "after": after }),
        )
        .await?;
        projects.extend(data.projects.nodes);
        if !data.projects.page_info.has_next_page {
            return Ok(projects);
        }
        after = data.projects.page_info.end_cursor;
        if after.is_none() {
            return Err(Error::LinearApi(
                "Linear returned an incomplete project page".into(),
            ));
        }
    }
}

pub async fn archive_project(token: &str, project_id: &str) -> Result<()> {
    #[derive(Deserialize)]
    struct Data {
        #[serde(rename = "projectArchive")]
        result: DeleteMutation,
    }
    let data: Data = query(
        token,
        "mutation RelayProjectArchive($id: String!) { projectArchive(id: $id) { success } }",
        json!({ "id": project_id }),
    )
    .await?;
    if data.result.success {
        Ok(())
    } else {
        Err(Error::LinearApi(
            "Linear did not archive the project".into(),
        ))
    }
}

pub async fn unarchive_project(token: &str, project_id: &str) -> Result<()> {
    #[derive(Deserialize)]
    struct Data {
        #[serde(rename = "projectUnarchive")]
        result: DeleteMutation,
    }
    let data: Data = query(
        token,
        "mutation RelayProjectUnarchive($id: String!) { projectUnarchive(id: $id) { success } }",
        json!({ "id": project_id }),
    )
    .await?;
    if data.result.success {
        Ok(())
    } else {
        Err(Error::LinearApi(
            "Linear did not restore the project".into(),
        ))
    }
}

pub async fn create_project(
    token: &str,
    team_ids: &[String],
    name: &str,
    description: Option<&str>,
    start_date: Option<&str>,
    target_date: Option<&str>,
    status_id: Option<&str>,
    lead_id: Option<&str>,
) -> Result<LinearProject> {
    #[derive(Deserialize)]
    struct Data {
        #[serde(rename = "projectCreate")]
        result: ProjectMutation,
    }
    let mut input = serde_json::Map::from_iter([
        ("name".into(), json!(name)),
        ("teamIds".into(), json!(team_ids)),
    ]);
    if let Some(description) = description {
        input.insert("description".into(), json!(description));
    }
    if let Some(start_date) = start_date {
        input.insert("startDate".into(), json!(start_date));
    }
    if let Some(target_date) = target_date {
        input.insert("targetDate".into(), json!(target_date));
    }
    if let Some(status_id) = status_id {
        input.insert("statusId".into(), json!(status_id));
    }
    if let Some(lead_id) = lead_id {
        input.insert("leadId".into(), json!(lead_id));
    }
    let data: Data = query(
        token,
        "mutation RelayProjectCreate($input: ProjectCreateInput!) { projectCreate(input: $input) { success project { id name description url startDate targetDate archivedAt status { id name type } lead { id name } teams { nodes { id name key } } } } }",
        json!({ "input": input }),
    )
    .await?;
    data.result.into_value("Linear did not create the project")
}

pub async fn update_project(
    token: &str,
    project_id: &str,
    name: &str,
    description: &str,
    start_date: Option<&str>,
    target_date: Option<&str>,
    status_id: Option<&str>,
    lead_id: Option<&str>,
    clear_lead: bool,
    team_ids: &[String],
) -> Result<LinearProject> {
    #[derive(Deserialize)]
    struct Data {
        #[serde(rename = "projectUpdate")]
        result: ProjectMutation,
    }
    let mut input = serde_json::Map::from_iter([
        ("name".into(), json!(name)),
        ("description".into(), json!(description)),
        ("startDate".into(), json!(start_date)),
        ("targetDate".into(), json!(target_date)),
    ]);
    if let Some(status_id) = status_id {
        input.insert("statusId".into(), json!(status_id));
    }
    if let Some(lead_id) = lead_id {
        input.insert("leadId".into(), json!(lead_id));
    }
    if clear_lead {
        input.insert("leadId".into(), Value::Null);
    }
    input.insert("teamIds".into(), json!(team_ids));
    let data: Data = query(
        token,
        "mutation RelayProjectUpdate($id: String!, $input: ProjectUpdateInput!) { projectUpdate(id: $id, input: $input) { success project { id name description url startDate targetDate archivedAt status { id name type } lead { id name } teams { nodes { id name key } } } } }",
        json!({ "id": project_id, "input": input }),
    )
    .await?;
    data.result.into_value("Linear did not update the project")
}

pub async fn project_resources(token: &str, project_id: &str) -> Result<LinearProjectResources> {
    #[derive(Deserialize)]
    struct Data {
        project: Option<ProjectDocuments>,
    }
    #[derive(Deserialize)]
    struct ProjectDocuments {
        documents: ResourceConnection<LinearDocument>,
    }
    let mut documents = Vec::new();
    let mut after = None;
    loop {
        let data: Data = query(
            token,
            "query RelayProjectDocuments($id: String!, $after: String) { project(id: $id) { documents(first: 100, after: $after) { nodes { id title url updatedAt creator { id name } } pageInfo { endCursor hasNextPage } } } }",
            json!({ "id": project_id, "after": after }),
        )
        .await?;
        let page = data
            .project
            .ok_or_else(|| Error::LinearApi("Linear project was not found".into()))?
            .documents;
        documents.extend(page.nodes);
        if !page.page_info.has_next_page {
            break;
        }
        after = page.page_info.end_cursor;
        if after.is_none() {
            return Err(Error::LinearApi(
                "Linear returned an incomplete document page".into(),
            ));
        }
    }

    #[derive(Deserialize)]
    struct LinkData {
        project: Option<ProjectLinks>,
    }
    #[derive(Deserialize)]
    struct ProjectLinks {
        #[serde(rename = "externalLinks")]
        external_links: ResourceConnection<LinearExternalLink>,
    }
    let mut external_links = Vec::new();
    let mut after = None;
    loop {
        let data: LinkData = query(
            token,
            "query RelayProjectExternalLinks($id: String!, $after: String) { project(id: $id) { externalLinks(first: 100, after: $after) { nodes { id label url } pageInfo { endCursor hasNextPage } } } }",
            json!({ "id": project_id, "after": after }),
        )
        .await?;
        let page = data
            .project
            .ok_or_else(|| Error::LinearApi("Linear project was not found".into()))?
            .external_links;
        external_links.extend(page.nodes);
        if !page.page_info.has_next_page {
            break;
        }
        after = page.page_info.end_cursor;
        if after.is_none() {
            return Err(Error::LinearApi(
                "Linear returned an incomplete external-link page".into(),
            ));
        }
    }

    Ok(LinearProjectResources {
        documents,
        external_links,
    })
}

pub async fn create_project_document(
    token: &str,
    project_id: &str,
    title: &str,
    content: &str,
) -> Result<LinearDocument> {
    #[derive(Deserialize)]
    struct Data {
        #[serde(rename = "documentCreate")]
        result: DocumentMutation,
    }
    let data: Data = query(
        token,
        "mutation RelayProjectDocumentCreate($input: DocumentCreateInput!) { documentCreate(input: $input) { success document { id title url updatedAt creator { id name } } } }",
        json!({ "input": { "projectId": project_id, "title": title, "content": content } }),
    )
    .await?;
    data.result
        .into_value("Linear did not create the project document")
}

pub async fn project_document(token: &str, document_id: &str) -> Result<LinearDocument> {
    #[derive(Deserialize)]
    struct Data {
        document: Option<LinearDocument>,
    }
    let data: Data = query(
        token,
        "query RelayProjectDocument($id: String!) { document(id: $id) { id title url updatedAt content creator { id name } } }",
        json!({ "id": document_id }),
    )
    .await?;
    data.document
        .ok_or_else(|| Error::LinearApi("Linear project document was not found".into()))
}

pub async fn update_project_document(
    token: &str,
    document_id: &str,
    expected_updated_at: &str,
    title: &str,
    content: &str,
) -> Result<LinearDocument> {
    let current = project_document(token, document_id).await?;
    ensure_document_fresh(&current.updated_at, expected_updated_at)?;

    #[derive(Deserialize)]
    struct Data {
        #[serde(rename = "documentUpdate")]
        result: DocumentMutation,
    }
    let data: Data = query(
        token,
        "mutation RelayProjectDocumentUpdate($id: String!, $input: DocumentUpdateInput!) { documentUpdate(id: $id, input: $input) { success document { id title url updatedAt content creator { id name } } } }",
        json!({ "id": document_id, "input": { "title": title, "content": content } }),
    )
    .await?;
    data.result
        .into_value("Linear did not update the project document")
}

fn ensure_document_fresh(current_updated_at: &str, expected_updated_at: &str) -> Result<()> {
    // ponytail: Linear has no update precondition; this catches prior edits but not a race after this read.
    if current_updated_at == expected_updated_at {
        Ok(())
    } else {
        Err(Error::LinearApi(
            "This document changed in Linear. Reload it to review the latest version before saving.".into(),
        ))
    }
}

pub async fn create_project_external_link(
    token: &str,
    project_id: &str,
    label: &str,
    url: &str,
) -> Result<LinearExternalLink> {
    #[derive(Deserialize)]
    struct Data {
        #[serde(rename = "entityExternalLinkCreate")]
        result: ExternalLinkMutation,
    }
    let data: Data = query(
        token,
        "mutation RelayProjectExternalLinkCreate($input: EntityExternalLinkCreateInput!) { entityExternalLinkCreate(input: $input) { success entityExternalLink { id label url } } }",
        json!({ "input": { "projectId": project_id, "label": label, "url": url } }),
    )
    .await?;
    data.result
        .into_value("Linear did not create the project link")
}

pub async fn delete_project_external_link(token: &str, link_id: &str) -> Result<()> {
    #[derive(Deserialize)]
    struct Data {
        #[serde(rename = "entityExternalLinkDelete")]
        result: DeleteMutation,
    }
    let data: Data = query(
        token,
        "mutation RelayProjectExternalLinkDelete($id: String!) { entityExternalLinkDelete(id: $id) { success } }",
        json!({ "id": link_id }),
    )
    .await?;
    if data.result.success {
        Ok(())
    } else {
        Err(Error::LinearApi(
            "Linear did not delete the project link".into(),
        ))
    }
}

pub async fn project_statuses(token: &str) -> Result<Vec<LinearProjectStatus>> {
    #[derive(Deserialize)]
    struct Data {
        #[serde(rename = "projectStatuses")]
        statuses: Nodes<LinearProjectStatus>,
    }
    Ok(query::<Data>(
        token,
        "query RelayProjectStatuses { projectStatuses(first: 100) { nodes { id name type } } }",
        json!({}),
    )
    .await?
    .statuses
    .nodes)
}

pub async fn project_milestones(token: &str, project_id: &str) -> Result<Vec<LinearMilestone>> {
    #[derive(Deserialize)]
    struct ProjectNode {
        project_milestones: ResourceConnection<LinearMilestone>,
    }
    #[derive(Deserialize)]
    struct Data {
        projects: Nodes<ProjectNode>,
    }
    let mut milestones = Vec::new();
    let mut after = None;
    loop {
        let data: Data = query(
            token,
            "query RelayProjectMilestones($projectId: String!, $after: String) { projects(filter: { id: { eq: $projectId } }, first: 1) { nodes { projectMilestones(first: 100, after: $after) { nodes { id name description targetDate } pageInfo { endCursor hasNextPage } } } } }",
            json!({ "projectId": project_id, "after": after }),
        )
        .await?;
        let Some(project) = data.projects.nodes.into_iter().next() else {
            return Ok(milestones);
        };
        milestones.extend(project.project_milestones.nodes);
        match next_page_cursor(&project.project_milestones.page_info, "milestone")? {
            Some(cursor) => after = Some(cursor),
            None => return Ok(milestones),
        }
    }
}

pub async fn project_updates(
    token: &str,
    project_id: &str,
    include_archived: bool,
) -> Result<Vec<LinearProjectUpdate>> {
    #[derive(Deserialize)]
    struct ProjectNode {
        project_updates: ResourceConnection<LinearProjectUpdate>,
    }
    #[derive(Deserialize)]
    struct Data {
        projects: Nodes<ProjectNode>,
    }
    let mut updates = Vec::new();
    let mut after = None;
    loop {
        let data: Data = query(
            token,
            "query RelayProjectUpdates($projectId: String!, $includeArchived: Boolean!, $after: String) { projects(filter: { id: { eq: $projectId } }, first: 1) { nodes { projectUpdates(first: 100, after: $after, includeArchived: $includeArchived, orderBy: createdAt) { nodes { id body health createdAt archivedAt user { id name } } pageInfo { endCursor hasNextPage } } } } }",
            json!({ "projectId": project_id, "includeArchived": include_archived, "after": after }),
        )
        .await?;
        let Some(project) = data.projects.nodes.into_iter().next() else {
            return Ok(updates);
        };
        updates.extend(project.project_updates.nodes);
        match next_page_cursor(&project.project_updates.page_info, "project update")? {
            Some(cursor) => after = Some(cursor),
            None => return Ok(updates),
        }
    }
}

pub async fn archive_project_update(token: &str, update_id: &str) -> Result<()> {
    #[derive(Deserialize)]
    struct Data {
        #[serde(rename = "projectUpdateArchive")]
        result: DeleteMutation,
    }
    let data: Data = query(
        token,
        "mutation RelayProjectUpdateArchive($id: String!) { projectUpdateArchive(id: $id) { success } }",
        json!({ "id": update_id }),
    )
    .await?;
    if data.result.success {
        Ok(())
    } else {
        Err(Error::LinearApi(
            "Linear did not archive the project update".into(),
        ))
    }
}

pub async fn unarchive_project_update(token: &str, update_id: &str) -> Result<()> {
    #[derive(Deserialize)]
    struct Data {
        #[serde(rename = "projectUpdateUnarchive")]
        result: DeleteMutation,
    }
    let data: Data = query(
        token,
        "mutation RelayProjectUpdateUnarchive($id: String!) { projectUpdateUnarchive(id: $id) { success } }",
        json!({ "id": update_id }),
    )
    .await?;
    if data.result.success {
        Ok(())
    } else {
        Err(Error::LinearApi(
            "Linear did not restore the project update".into(),
        ))
    }
}

pub async fn create_project_update(
    token: &str,
    project_id: &str,
    body: &str,
    health: &str,
) -> Result<LinearProjectUpdate> {
    #[derive(Deserialize)]
    struct Data {
        #[serde(rename = "projectUpdateCreate")]
        result: ProjectUpdateMutation,
    }
    let data: Data = query(
        token,
        "mutation RelayProjectUpdateCreate($input: ProjectUpdateCreateInput!) { projectUpdateCreate(input: $input) { success projectUpdate { id body health createdAt user { id name } } } }",
        json!({ "input": { "projectId": project_id, "body": body, "health": health } }),
    )
    .await?;
    data.result
        .into_value("Linear did not create the project update")
}

pub async fn update_project_update(
    token: &str,
    update_id: &str,
    body: &str,
    health: &str,
) -> Result<LinearProjectUpdate> {
    #[derive(Deserialize)]
    struct Data {
        #[serde(rename = "projectUpdateUpdate")]
        result: ProjectUpdateMutation,
    }
    let data: Data = query(
        token,
        "mutation RelayProjectUpdateEdit($id: String!, $input: ProjectUpdateUpdateInput!) { projectUpdateUpdate(id: $id, input: $input) { success projectUpdate { id body health createdAt user { id name } } } }",
        json!({ "id": update_id, "input": { "body": body, "health": health } }),
    )
    .await?;
    data.result
        .into_value("Linear did not update the project update")
}

pub async fn create_milestone(
    token: &str,
    project_id: &str,
    name: &str,
    description: Option<&str>,
    target_date: Option<&str>,
) -> Result<LinearMilestone> {
    #[derive(Deserialize)]
    struct Data {
        #[serde(rename = "projectMilestoneCreate")]
        result: MilestoneMutation,
    }
    let mut input = serde_json::Map::from_iter([
        ("projectId".into(), json!(project_id)),
        ("name".into(), json!(name)),
    ]);
    if let Some(description) = description {
        input.insert("description".into(), json!(description));
    }
    if let Some(target_date) = target_date {
        input.insert("targetDate".into(), json!(target_date));
    }
    let data: Data = query(
        token,
        "mutation RelayMilestoneCreate($input: ProjectMilestoneCreateInput!) { projectMilestoneCreate(input: $input) { success projectMilestone { id name description targetDate } } }",
        json!({ "input": input }),
    )
    .await?;
    data.result
        .into_value("Linear did not create the milestone")
}

pub async fn update_milestone(
    token: &str,
    milestone_id: &str,
    name: &str,
    description: &str,
    target_date: Option<&str>,
) -> Result<LinearMilestone> {
    #[derive(Deserialize)]
    struct Data {
        #[serde(rename = "projectMilestoneUpdate")]
        result: MilestoneMutation,
    }
    let data: Data = query(
        token,
        "mutation RelayMilestoneUpdate($id: String!, $input: ProjectMilestoneUpdateInput!) { projectMilestoneUpdate(id: $id, input: $input) { success projectMilestone { id name description targetDate } } }",
        json!({ "id": milestone_id, "input": { "name": name, "description": description, "targetDate": target_date } }),
    )
    .await?;
    data.result
        .into_value("Linear did not update the milestone")
}

pub async fn delete_milestone(token: &str, milestone_id: &str) -> Result<()> {
    #[derive(Deserialize)]
    struct Data {
        #[serde(rename = "projectMilestoneDelete")]
        result: DeleteMutation,
    }
    let data: Data = query(
        token,
        "mutation RelayMilestoneDelete($id: String!) { projectMilestoneDelete(id: $id) { success } }",
        json!({ "id": milestone_id }),
    )
    .await?;
    if data.result.success {
        Ok(())
    } else {
        Err(Error::LinearApi(
            "Linear did not delete the milestone".into(),
        ))
    }
}

pub async fn initiatives(
    token: &str,
    include_archived: bool,
    include_archived_updates: bool,
) -> Result<Vec<Initiative>> {
    #[derive(Deserialize)]
    struct InitiativeNode {
        id: String,
        name: String,
        description: Option<String>,
        #[serde(rename = "targetDate")]
        target_date: Option<String>,
        #[serde(rename = "archivedAt")]
        archived_at: Option<String>,
        #[serde(rename = "initiativeUpdates")]
        updates: ResourceConnection<InitiativeUpdate>,
    }
    #[derive(Deserialize)]
    struct InitiativesData {
        initiatives: ResourceConnection<InitiativeNode>,
    }
    #[derive(Deserialize)]
    struct InitiativeProjectsData {
        #[serde(rename = "initiativeToProjects")]
        project_links: ResourceConnection<InitiativeProjectNode>,
    }
    #[derive(Deserialize)]
    struct InitiativeProjectNode {
        id: String,
        initiative: InitiativeRef,
        project: ProjectRef,
    }
    #[derive(Deserialize)]
    struct InitiativeRef {
        id: String,
    }
    let mut initiative_nodes = Vec::new();
    let mut after = None;
    loop {
        let data: InitiativesData = query(
            token,
            "query RelayInitiatives($includeArchived: Boolean!, $includeArchivedUpdates: Boolean!, $after: String) { initiatives(first: 100, after: $after, includeArchived: $includeArchived) { nodes { id name description targetDate archivedAt initiativeUpdates(first: 100, includeArchived: $includeArchivedUpdates) { nodes { id body health createdAt archivedAt user { id name } } pageInfo { endCursor hasNextPage } } } pageInfo { endCursor hasNextPage } } }",
            json!({ "includeArchived": include_archived, "includeArchivedUpdates": include_archived_updates, "after": after }),
        )
        .await?;
        initiative_nodes.extend(data.initiatives.nodes);
        match next_page_cursor(&data.initiatives.page_info, "initiative")? {
            Some(cursor) => after = Some(cursor),
            None => break,
        }
    }

    let mut project_links = Vec::new();
    let mut after = None;
    loop {
        let data: InitiativeProjectsData = query(
            token,
            "query RelayInitiativeProjects($includeArchived: Boolean!, $after: String) { initiativeToProjects(first: 100, after: $after, includeArchived: $includeArchived) { nodes { id initiative { id } project { id name teams { nodes { id name key } } } } pageInfo { endCursor hasNextPage } } }",
            json!({ "includeArchived": include_archived, "after": after }),
        )
        .await?;
        project_links.extend(data.project_links.nodes);
        match next_page_cursor(&data.project_links.page_info, "initiative project link")? {
            Some(cursor) => after = Some(cursor),
            None => break,
        }
    }

    for initiative in &mut initiative_nodes {
        let mut updates = std::mem::take(&mut initiative.updates.nodes);
        let mut after = next_page_cursor(&initiative.updates.page_info, "initiative update")?;
        while let Some(cursor) = after {
            #[derive(Deserialize)]
            struct UpdatesData {
                initiative: Option<InitiativeUpdatesNode>,
            }
            #[derive(Deserialize)]
            struct InitiativeUpdatesNode {
                #[serde(rename = "initiativeUpdates")]
                updates: ResourceConnection<InitiativeUpdate>,
            }
            let data: UpdatesData = query(
                token,
                "query RelayInitiativeUpdates($id: String!, $includeArchived: Boolean!, $after: String) { initiative(id: $id) { initiativeUpdates(first: 100, after: $after, includeArchived: $includeArchived) { nodes { id body health createdAt archivedAt user { id name } } pageInfo { endCursor hasNextPage } } } }",
                json!({ "id": initiative.id, "includeArchived": include_archived_updates, "after": cursor }),
            )
            .await?;
            let Some(page) = data.initiative.map(|initiative| initiative.updates) else {
                return Err(Error::LinearApi("Linear initiative was not found".into()));
            };
            updates.extend(page.nodes);
            after = next_page_cursor(&page.page_info, "initiative update")?;
        }
        initiative.updates.nodes = updates;
    }

    let mut projects = HashMap::<String, Vec<InitiativeProject>>::new();
    for link in project_links {
        projects
            .entry(link.initiative.id)
            .or_default()
            .push(InitiativeProject {
                id: link.id,
                project: link.project,
            });
    }
    Ok(initiative_nodes
        .into_iter()
        .map(|initiative| Initiative {
            id: initiative.id.clone(),
            name: initiative.name,
            description: initiative.description,
            target_date: initiative.target_date,
            archived_at: initiative.archived_at,
            projects: projects.remove(&initiative.id).unwrap_or_default(),
            updates: initiative.updates.nodes,
        })
        .collect())
}

pub async fn create_initiative_update(
    token: &str,
    initiative_id: &str,
    body: &str,
    health: &str,
) -> Result<InitiativeUpdate> {
    #[derive(Deserialize)]
    struct Data {
        #[serde(rename = "initiativeUpdateCreate")]
        result: InitiativeUpdateMutation,
    }
    let data: Data = query(
        token,
        "mutation RelayInitiativeUpdateCreate($input: InitiativeUpdateCreateInput!) { initiativeUpdateCreate(input: $input) { success initiativeUpdate { id body health createdAt archivedAt user { id name } } } }",
        json!({ "input": { "initiativeId": initiative_id, "body": body, "health": health } }),
    )
    .await?;
    data.result
        .into_value("Linear did not create the initiative update")
}

pub async fn update_initiative_update(
    token: &str,
    update_id: &str,
    body: &str,
    health: &str,
) -> Result<InitiativeUpdate> {
    #[derive(Deserialize)]
    struct Data {
        #[serde(rename = "initiativeUpdateUpdate")]
        result: InitiativeUpdateMutation,
    }
    let data: Data = query(
        token,
        "mutation RelayInitiativeUpdateEdit($id: String!, $input: InitiativeUpdateUpdateInput!) { initiativeUpdateUpdate(id: $id, input: $input) { success initiativeUpdate { id body health createdAt archivedAt user { id name } } } }",
        json!({ "id": update_id, "input": { "body": body, "health": health } }),
    )
    .await?;
    data.result
        .into_value("Linear did not update the initiative update")
}

pub async fn archive_initiative_update(token: &str, update_id: &str) -> Result<()> {
    #[derive(Deserialize)]
    struct Data {
        #[serde(rename = "initiativeUpdateArchive")]
        result: DeleteMutation,
    }
    let data: Data = query(
        token,
        "mutation RelayInitiativeUpdateArchive($id: String!) { initiativeUpdateArchive(id: $id) { success } }",
        json!({ "id": update_id }),
    )
    .await?;
    if data.result.success {
        Ok(())
    } else {
        Err(Error::LinearApi(
            "Linear did not archive the initiative update".into(),
        ))
    }
}

pub async fn unarchive_initiative_update(token: &str, update_id: &str) -> Result<()> {
    #[derive(Deserialize)]
    struct Data {
        #[serde(rename = "initiativeUpdateUnarchive")]
        result: DeleteMutation,
    }
    let data: Data = query(
        token,
        "mutation RelayInitiativeUpdateUnarchive($id: String!) { initiativeUpdateUnarchive(id: $id) { success } }",
        json!({ "id": update_id }),
    )
    .await?;
    if data.result.success {
        Ok(())
    } else {
        Err(Error::LinearApi(
            "Linear did not restore the initiative update".into(),
        ))
    }
}

pub async fn archive_initiative(token: &str, initiative_id: &str) -> Result<()> {
    #[derive(Deserialize)]
    struct Data {
        #[serde(rename = "initiativeArchive")]
        result: DeleteMutation,
    }
    let data: Data = query(
        token,
        "mutation RelayInitiativeArchive($id: String!) { initiativeArchive(id: $id) { success } }",
        json!({ "id": initiative_id }),
    )
    .await?;
    if data.result.success {
        Ok(())
    } else {
        Err(Error::LinearApi(
            "Linear did not archive the initiative".into(),
        ))
    }
}

pub async fn unarchive_initiative(token: &str, initiative_id: &str) -> Result<()> {
    #[derive(Deserialize)]
    struct Data {
        #[serde(rename = "initiativeUnarchive")]
        result: DeleteMutation,
    }
    let data: Data = query(
        token,
        "mutation RelayInitiativeUnarchive($id: String!) { initiativeUnarchive(id: $id) { success } }",
        json!({ "id": initiative_id }),
    )
    .await?;
    if data.result.success {
        Ok(())
    } else {
        Err(Error::LinearApi(
            "Linear did not restore the initiative".into(),
        ))
    }
}

pub async fn create_initiative(
    token: &str,
    name: &str,
    description: Option<&str>,
    target_date: Option<&str>,
) -> Result<Initiative> {
    #[derive(Deserialize)]
    struct Data {
        #[serde(rename = "initiativeCreate")]
        result: InitiativeMutation,
    }
    let mut input = serde_json::Map::from_iter([("name".into(), json!(name))]);
    if let Some(description) = description {
        input.insert("description".into(), json!(description));
    }
    if let Some(target_date) = target_date {
        input.insert("targetDate".into(), json!(target_date));
    }
    let data: Data = query(
        token,
        "mutation RelayInitiativeCreate($input: InitiativeCreateInput!) { initiativeCreate(input: $input) { success initiative { id name description targetDate } } }",
        json!({ "input": input }),
    )
    .await?;
    data.result
        .into_value("Linear did not create the initiative")
}

pub async fn update_initiative(
    token: &str,
    initiative_id: &str,
    name: &str,
    description: &str,
    target_date: Option<&str>,
) -> Result<Initiative> {
    #[derive(Deserialize)]
    struct Data {
        #[serde(rename = "initiativeUpdate")]
        result: InitiativeMutation,
    }
    let data: Data = query(
        token,
        "mutation RelayInitiativeUpdate($id: String!, $input: InitiativeUpdateInput!) { initiativeUpdate(id: $id, input: $input) { success initiative { id name description targetDate } } }",
        json!({
            "id": initiative_id,
            "input": { "name": name, "description": description, "targetDate": target_date }
        }),
    )
    .await?;
    data.result
        .into_value("Linear did not update the initiative")
}

pub async fn add_project_to_initiative(
    token: &str,
    initiative_id: &str,
    project_id: &str,
) -> Result<InitiativeProject> {
    #[derive(Deserialize)]
    struct Data {
        #[serde(rename = "initiativeToProjectCreate")]
        result: InitiativeProjectMutation,
    }
    let data: Data = query(
        token,
        "mutation RelayInitiativeProjectCreate($input: InitiativeToProjectCreateInput!) { initiativeToProjectCreate(input: $input) { success initiativeToProject { id project { id name } } } }",
        json!({ "input": { "initiativeId": initiative_id, "projectId": project_id } }),
    )
    .await?;
    data.result
        .into_value("Linear did not link the project to the initiative")
}

pub async fn remove_project_from_initiative(token: &str, link_id: &str) -> Result<()> {
    #[derive(Deserialize)]
    struct Data {
        #[serde(rename = "initiativeToProjectDelete")]
        result: DeleteMutation,
    }
    let data: Data = query(
        token,
        "mutation RelayInitiativeProjectDelete($id: String!) { initiativeToProjectDelete(id: $id) { success } }",
        json!({ "id": link_id }),
    )
    .await?;
    if data.result.success {
        Ok(())
    } else {
        Err(Error::LinearApi("Linear did not unlink the project".into()))
    }
}

pub async fn cycles(token: &str, team_id: &str) -> Result<Vec<LinearCycle>> {
    #[derive(Deserialize)]
    struct Data {
        cycles: ResourceConnection<LinearCycle>,
    }
    let mut cycles = Vec::new();
    let mut after = None;
    loop {
        let data: Data = query(
            token,
            "query RelayCycles($teamId: String!, $after: String) { cycles(filter: { team: { id: { eq: $teamId } } }, first: 100, after: $after) { nodes { id name description number startsAt endsAt isActive team { id name key timezone } } pageInfo { endCursor hasNextPage } } }",
            json!({ "teamId": team_id, "after": after }),
        )
        .await?;
        cycles.extend(data.cycles.nodes);
        match next_page_cursor(&data.cycles.page_info, "cycle")? {
            Some(cursor) => after = Some(cursor),
            None => return Ok(cycles),
        }
    }
}

pub async fn create_cycle(
    token: &str,
    team_id: &str,
    name: Option<&str>,
    starts_at: &str,
    ends_at: &str,
) -> Result<LinearCycle> {
    #[derive(Deserialize)]
    struct Data {
        #[serde(rename = "cycleCreate")]
        result: CycleMutation,
    }
    let data: Data = query(
        token,
        "mutation RelayCycleCreate($input: CycleCreateInput!) { cycleCreate(input: $input) { success cycle { id name description number startsAt endsAt isActive team { id name key timezone } } } }",
        json!({ "input": cycle_create_input(team_id, name, starts_at, ends_at) }),
    )
    .await?;
    data.result.into_value("Linear did not create the cycle")
}

fn cycle_create_input(team_id: &str, name: Option<&str>, starts_at: &str, ends_at: &str) -> Value {
    let mut input = serde_json::Map::new();
    input.insert("teamId".into(), json!(team_id));
    if let Some(name) = name.filter(|name| !name.trim().is_empty()) {
        input.insert("name".into(), json!(name.trim()));
    }
    input.insert("startsAt".into(), json!(starts_at));
    input.insert("endsAt".into(), json!(ends_at));
    Value::Object(input)
}

pub async fn update_cycle(
    token: &str,
    cycle_id: &str,
    name: &str,
    description: &str,
    starts_at: Option<&str>,
    ends_at: Option<&str>,
) -> Result<LinearCycle> {
    #[derive(Deserialize)]
    struct Data {
        #[serde(rename = "cycleUpdate")]
        result: CycleMutation,
    }
    let mut input = serde_json::Map::new();
    input.insert(
        "name".into(),
        if name.trim().is_empty() {
            Value::Null
        } else {
            json!(name.trim())
        },
    );
    input.insert("description".into(), json!(description));
    if let Some(starts_at) = starts_at {
        input.insert("startsAt".into(), json!(starts_at));
    }
    if let Some(ends_at) = ends_at {
        input.insert("endsAt".into(), json!(ends_at));
    }
    let data: Data = query(
        token,
        "mutation RelayCycleUpdate($id: String!, $input: CycleUpdateInput!) { cycleUpdate(id: $id, input: $input) { success cycle { id name description number startsAt endsAt isActive team { id name key timezone } } } }",
        json!({ "id": cycle_id, "input": input }),
    )
    .await?;
    data.result.into_value("Linear did not update the cycle")
}

pub async fn project_issues(
    token: &str,
    project_id: &str,
    after: Option<&str>,
    include_archived: bool,
    search: Option<&str>,
    state_id: Option<&str>,
    priority: Option<u8>,
    assignee_id: Option<&str>,
    label_id: Option<&str>,
) -> Result<IssuePage> {
    issues(
        token,
        json!({ "project": { "id": { "eq": project_id } } }),
        search,
        after,
        include_archived,
        state_id,
        priority,
        assignee_id,
        label_id,
        None,
    )
    .await
}

pub async fn workflow_states(token: &str, team_id: &str) -> Result<Vec<WorkflowState>> {
    #[derive(Deserialize)]
    struct Data {
        #[serde(rename = "workflowStates")]
        workflow_states: Nodes<WorkflowState>,
    }

    Ok(query::<Data>(
        token,
        "query RelayWorkflowStates { workflowStates { nodes { id name type team { id } } } }",
        json!({}),
    )
    .await?
    .workflow_states
    .nodes)
    .map(|states| {
        states
            .into_iter()
            .filter(|state| state.team.as_ref().is_some_and(|team| team.id == team_id))
            .collect()
    })
}

pub async fn create_issue(
    token: &str,
    team_id: &str,
    title: &str,
    description: Option<&str>,
    estimate: Option<u32>,
    assignee_id: Option<&str>,
    priority: Option<u8>,
    due_date: Option<&str>,
    label_ids: Option<&[String]>,
    project_id: Option<&str>,
    project_milestone_id: Option<&str>,
    parent_id: Option<&str>,
    state_id: Option<&str>,
    cycle_id: Option<&str>,
) -> Result<Issue> {
    #[derive(Deserialize)]
    struct Data {
        #[serde(rename = "issueCreate")]
        result: MutationResult<Issue>,
    }

    let mut input = serde_json::Map::from_iter([
        ("teamId".into(), json!(team_id)),
        ("title".into(), json!(title)),
    ]);
    if let Some(description) = description {
        input.insert("description".into(), json!(description));
    }
    if let Some(estimate) = estimate {
        input.insert("estimate".into(), json!(estimate));
    }
    if let Some(assignee_id) = assignee_id {
        input.insert("assigneeId".into(), json!(assignee_id));
    }
    if let Some(priority) = priority {
        input.insert("priority".into(), json!(priority));
    }
    if let Some(due_date) = due_date {
        input.insert("dueDate".into(), json!(due_date));
    }
    if let Some(label_ids) = label_ids {
        input.insert("labelIds".into(), json!(label_ids));
    }
    if let Some(project_id) = project_id {
        input.insert("projectId".into(), json!(project_id));
    }
    if let Some(project_milestone_id) = project_milestone_id {
        input.insert("projectMilestoneId".into(), json!(project_milestone_id));
    }
    if let Some(parent_id) = parent_id {
        input.insert("parentId".into(), json!(parent_id));
    }
    if let Some(state_id) = state_id {
        input.insert("stateId".into(), json!(state_id));
    }
    if let Some(cycle_id) = cycle_id {
        input.insert("cycleId".into(), json!(cycle_id));
    }
    let data: Data = query(
        token,
        "mutation RelayIssueCreate($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier title description url priority estimate dueDate updatedAt state { id name type } assignee { id name } project { id name } cycle { id name number } labels { nodes { id name color } } team { id name key } } } }",
        json!({ "input": input }),
    )
    .await?;
    data.result.into_value("Linear did not create the issue")
}

pub async fn issue_detail(token: &str, issue_id: &str) -> Result<IssueDetail> {
    #[derive(Deserialize)]
    struct IssueNode {
        #[serde(flatten)]
        issue: Issue,
        children: Nodes<Issue>,
        comments: Nodes<LinearComment>,
        relations: Nodes<IssueRelation>,
        inverse_relations: Nodes<IssueRelation>,
    }
    #[derive(Deserialize)]
    struct Data {
        issue: IssueNode,
    }
    let data: Data = query(
        token,
        "query RelayIssueDetail($id: String!) { issue(id: $id) { id identifier title description url priority estimate dueDate updatedAt archivedAt state { id name type } assignee { id name } project { id name } projectMilestone { id name } cycle { id name number } labels { nodes { id name color } } team { id name key } children(first: 50) { nodes { id identifier title description url priority updatedAt archivedAt state { id name type } assignee { id name } project { id name } cycle { id name number } labels { nodes { id name color } } team { id name key } } } relations(first: 50) { nodes { id type relatedIssue { id identifier title url } } } inverseRelations(first: 50) { nodes { id type issue { id identifier title url } } } comments(first: 50) { nodes { id body createdAt editedAt user { id name } } } } }",
        json!({ "id": issue_id }),
    )
    .await?;
    Ok(IssueDetail {
        issue: data.issue.issue,
        children: data.issue.children.nodes,
        comments: data.issue.comments.nodes,
        relations: data.issue.relations.nodes,
        inverse_relations: data.issue.inverse_relations.nodes,
    })
}

pub async fn create_issue_relation(
    token: &str,
    issue_id: &str,
    related_issue_id: &str,
    kind: &str,
) -> Result<IssueRelation> {
    #[derive(Deserialize)]
    struct Data {
        #[serde(rename = "issueRelationCreate")]
        result: IssueRelationMutation,
    }
    let data: Data = query(
        token,
        "mutation RelayIssueRelationCreate($input: IssueRelationCreateInput!) { issueRelationCreate(input: $input) { success issueRelation { id type issue { id identifier title url } relatedIssue { id identifier title url } } } }",
        json!({ "input": { "issueId": issue_id, "relatedIssueId": related_issue_id, "type": kind } }),
    )
    .await?;
    data.result
        .into_value("Linear did not create the issue relation")
}

pub async fn delete_issue_relation(token: &str, relation_id: &str) -> Result<()> {
    #[derive(Deserialize)]
    struct Data {
        #[serde(rename = "issueRelationDelete")]
        result: DeleteMutation,
    }
    let data: Data = query(
        token,
        "mutation RelayIssueRelationDelete($id: String!) { issueRelationDelete(id: $id) { success } }",
        json!({ "id": relation_id }),
    )
    .await?;
    if data.result.success {
        Ok(())
    } else {
        Err(Error::LinearApi(
            "Linear did not remove the issue relation".into(),
        ))
    }
}

pub async fn create_comment(token: &str, issue_id: &str, body: &str) -> Result<LinearComment> {
    #[derive(Deserialize)]
    struct Data {
        #[serde(rename = "commentCreate")]
        result: CommentMutation,
    }
    let data: Data = query(
        token,
        "mutation RelayCommentCreate($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id body createdAt editedAt user { id name } } } }",
        json!({ "input": { "issueId": issue_id, "body": body } }),
    )
    .await?;
    data.result.into_value("Linear did not create the comment")
}

pub async fn update_agent_issue_state(
    token: &str,
    issue_id: &str,
    state_id: &str,
) -> Result<Issue> {
    update_issue(
        token,
        issue_id,
        Some(state_id),
        None,
        false,
        None,
        false,
        None,
        None,
        None,
        None,
        None,
        false,
        None,
        false,
        None,
        false,
        None,
        false,
    )
    .await
}

pub async fn ensure_issue_project(token: &str, issue_id: &str, project_id: &str) -> Result<()> {
    #[derive(Deserialize)]
    struct IssueProject {
        project: Option<ProjectRef>,
    }
    #[derive(Deserialize)]
    struct Data {
        issue: Option<IssueProject>,
    }
    let data: Data = query(
        token,
        "query RelayAgentIssueProject($id: String!) { issue(id: $id) { project { id } } }",
        json!({ "id": issue_id }),
    )
    .await?;
    let actual_project_id = data
        .issue
        .and_then(|issue| issue.project)
        .map(|project| project.id);
    if issue_matches_project(actual_project_id.as_deref(), project_id) {
        Ok(())
    } else {
        Err(Error::LinearApi(
            "Relay agent issue is outside the allowed project".into(),
        ))
    }
}

fn issue_matches_project(actual_project_id: Option<&str>, expected_project_id: &str) -> bool {
    actual_project_id == Some(expected_project_id)
}

pub async fn update_comment(token: &str, comment_id: &str, body: &str) -> Result<LinearComment> {
    #[derive(Deserialize)]
    struct Data {
        #[serde(rename = "commentUpdate")]
        result: CommentMutation,
    }
    let data: Data = query(
        token,
        "mutation RelayCommentUpdate($id: String!, $input: CommentUpdateInput!) { commentUpdate(id: $id, input: $input) { success comment { id body createdAt editedAt user { id name } } } }",
        json!({ "id": comment_id, "input": { "body": body } }),
    )
    .await?;
    data.result.into_value("Linear did not update the comment")
}

pub async fn delete_comment(token: &str, comment_id: &str) -> Result<()> {
    #[derive(Deserialize)]
    struct Data {
        #[serde(rename = "commentDelete")]
        result: DeleteMutation,
    }
    let data: Data = query(
        token,
        "mutation RelayCommentDelete($id: String!) { commentDelete(id: $id) { success } }",
        json!({ "id": comment_id }),
    )
    .await?;
    if data.result.success {
        Ok(())
    } else {
        Err(Error::LinearApi("Linear did not delete the comment".into()))
    }
}

pub async fn update_issue(
    token: &str,
    issue_id: &str,
    state_id: Option<&str>,
    assignee_id: Option<&str>,
    clear_assignee: bool,
    cycle_id: Option<&str>,
    clear_cycle: bool,
    priority: Option<u8>,
    label_ids: Option<&[String]>,
    title: Option<&str>,
    description: Option<&str>,
    project_id: Option<&str>,
    clear_project: bool,
    project_milestone_id: Option<&str>,
    clear_project_milestone: bool,
    due_date: Option<&str>,
    clear_due_date: bool,
    estimate: Option<u32>,
    clear_estimate: bool,
) -> Result<Issue> {
    #[derive(Deserialize)]
    struct Data {
        #[serde(rename = "issueUpdate")]
        result: MutationResult<Issue>,
    }

    let mut input = serde_json::Map::new();
    if let Some(state_id) = state_id {
        input.insert("stateId".into(), json!(state_id));
    }
    if let Some(assignee_id) = assignee_id {
        input.insert("assigneeId".into(), json!(assignee_id));
    }
    if clear_assignee {
        input.insert("assigneeId".into(), Value::Null);
    }
    if let Some(cycle_id) = cycle_id {
        input.insert("cycleId".into(), json!(cycle_id));
    }
    if clear_cycle {
        input.insert("cycleId".into(), Value::Null);
    }
    if let Some(priority) = priority {
        input.insert("priority".into(), json!(priority));
    }
    if let Some(label_ids) = label_ids {
        input.insert("labelIds".into(), json!(label_ids));
    }
    if let Some(title) = title {
        input.insert("title".into(), json!(title));
    }
    if let Some(description) = description {
        input.insert("description".into(), json!(description));
    }
    if let Some(project_id) = project_id {
        input.insert("projectId".into(), json!(project_id));
        input.insert("projectMilestoneId".into(), Value::Null);
    }
    if clear_project {
        input.insert("projectId".into(), Value::Null);
        input.insert("projectMilestoneId".into(), Value::Null);
    }
    if let Some(project_milestone_id) = project_milestone_id {
        input.insert("projectMilestoneId".into(), json!(project_milestone_id));
    }
    if clear_project_milestone {
        input.insert("projectMilestoneId".into(), Value::Null);
    }
    if let Some(due_date) = due_date {
        input.insert("dueDate".into(), json!(due_date));
    }
    if clear_due_date {
        input.insert("dueDate".into(), Value::Null);
    }
    if let Some(estimate) = estimate {
        input.insert("estimate".into(), json!(estimate));
    }
    if clear_estimate {
        input.insert("estimate".into(), Value::Null);
    }
    let data: Data = query(
        token,
        "mutation RelayIssueUpdate($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success issue { id identifier title description url priority estimate dueDate updatedAt state { id name type } assignee { id name } project { id name } projectMilestone { id name } cycle { id name number } labels { nodes { id name color } } team { id name key } } } }",
        json!({
            "id": issue_id,
            "input": input
        }),
    )
    .await?;
    data.result.into_value("Linear did not update the issue")
}

#[derive(Deserialize)]
struct MutationResult<T> {
    success: bool,
    #[serde(rename = "issue")]
    value: Option<T>,
}

#[derive(Deserialize)]
struct ProjectMutation {
    success: bool,
    project: Option<LinearProject>,
}

#[derive(Deserialize)]
struct DocumentMutation {
    success: bool,
    document: Option<LinearDocument>,
}

#[derive(Deserialize)]
struct ExternalLinkMutation {
    success: bool,
    #[serde(rename = "entityExternalLink")]
    link: Option<LinearExternalLink>,
}

#[derive(Deserialize)]
struct CycleMutation {
    success: bool,
    cycle: Option<LinearCycle>,
}

#[derive(Deserialize)]
struct MilestoneMutation {
    success: bool,
    #[serde(rename = "projectMilestone")]
    milestone: Option<LinearMilestone>,
}

#[derive(Deserialize)]
struct ProjectUpdateMutation {
    success: bool,
    #[serde(rename = "projectUpdate")]
    project_update: Option<LinearProjectUpdate>,
}

#[derive(Deserialize)]
struct InitiativeMutation {
    success: bool,
    initiative: Option<Initiative>,
}

#[derive(Deserialize)]
struct InitiativeUpdateMutation {
    success: bool,
    #[serde(rename = "initiativeUpdate")]
    initiative_update: Option<InitiativeUpdate>,
}

#[derive(Deserialize)]
struct InitiativeProjectMutation {
    success: bool,
    #[serde(rename = "initiativeToProject")]
    initiative_project: Option<InitiativeProject>,
}

#[derive(Deserialize)]
struct DeleteMutation {
    success: bool,
}

#[derive(Deserialize)]
struct IssueRelationMutation {
    success: bool,
    #[serde(rename = "issueRelation")]
    issue_relation: Option<IssueRelation>,
}

#[derive(Deserialize)]
struct IssueLabelMutation {
    success: bool,
    #[serde(rename = "issueLabel")]
    issue_label: Option<LinearLabel>,
}

impl IssueLabelMutation {
    fn into_value(self, message: &str) -> Result<LinearLabel> {
        if !self.success {
            return Err(Error::LinearApi(message.into()));
        }
        self.issue_label
            .ok_or_else(|| Error::LinearApi("Linear returned no label".into()))
    }
}

impl IssueRelationMutation {
    fn into_value(self, message: &str) -> Result<IssueRelation> {
        if !self.success {
            return Err(Error::LinearApi(message.into()));
        }
        self.issue_relation
            .ok_or_else(|| Error::LinearApi("Linear returned no issue relation".into()))
    }
}

impl InitiativeMutation {
    fn into_value(self, message: &str) -> Result<Initiative> {
        if !self.success {
            return Err(Error::LinearApi(message.into()));
        }
        self.initiative
            .ok_or_else(|| Error::LinearApi("Linear returned no initiative".into()))
    }
}

impl InitiativeUpdateMutation {
    fn into_value(self, message: &str) -> Result<InitiativeUpdate> {
        if self.success {
            self.initiative_update
                .ok_or_else(|| Error::LinearApi("Linear returned no initiative update".into()))
        } else {
            Err(Error::LinearApi(message.into()))
        }
    }
}

impl InitiativeProjectMutation {
    fn into_value(self, message: &str) -> Result<InitiativeProject> {
        if self.success {
            self.initiative_project
                .ok_or_else(|| Error::LinearApi("Linear returned no project link".into()))
        } else {
            Err(Error::LinearApi(message.into()))
        }
    }
}

#[derive(Deserialize)]
struct CommentMutation {
    success: bool,
    comment: Option<LinearComment>,
}

impl CommentMutation {
    fn into_value(self, message: &str) -> Result<LinearComment> {
        if self.success {
            self.comment
                .ok_or_else(|| Error::LinearApi("Linear returned no comment".into()))
        } else {
            Err(Error::LinearApi(message.into()))
        }
    }
}

impl MilestoneMutation {
    fn into_value(self, message: &str) -> Result<LinearMilestone> {
        if self.success {
            self.milestone
                .ok_or_else(|| Error::LinearApi("Linear returned no milestone".into()))
        } else {
            Err(Error::LinearApi(message.into()))
        }
    }
}

impl ProjectUpdateMutation {
    fn into_value(self, message: &str) -> Result<LinearProjectUpdate> {
        if self.success {
            self.project_update
                .ok_or_else(|| Error::LinearApi("Linear returned no project update".into()))
        } else {
            Err(Error::LinearApi(message.into()))
        }
    }
}

impl ProjectMutation {
    fn into_value(self, message: &str) -> Result<LinearProject> {
        if self.success {
            self.project
                .ok_or_else(|| Error::LinearApi("Linear returned no project".into()))
        } else {
            Err(Error::LinearApi(message.into()))
        }
    }
}

impl DocumentMutation {
    fn into_value(self, message: &str) -> Result<LinearDocument> {
        if self.success {
            self.document
                .ok_or_else(|| Error::LinearApi("Linear returned no project document".into()))
        } else {
            Err(Error::LinearApi(message.into()))
        }
    }
}

impl ExternalLinkMutation {
    fn into_value(self, message: &str) -> Result<LinearExternalLink> {
        if self.success {
            self.link
                .ok_or_else(|| Error::LinearApi("Linear returned no project link".into()))
        } else {
            Err(Error::LinearApi(message.into()))
        }
    }
}

impl CycleMutation {
    fn into_value(self, message: &str) -> Result<LinearCycle> {
        if self.success {
            self.cycle
                .ok_or_else(|| Error::LinearApi("Linear returned no cycle".into()))
        } else {
            Err(Error::LinearApi(message.into()))
        }
    }
}

impl<T> MutationResult<T> {
    fn into_value(self, message: &str) -> Result<T> {
        if self.success {
            self.value
                .ok_or_else(|| Error::LinearApi("Linear returned no issue".into()))
        } else {
            Err(Error::LinearApi(message.into()))
        }
    }
}

pub async fn my_issues(
    token: &str,
    assignee_id: &str,
    search: Option<&str>,
    after: Option<&str>,
    include_archived: bool,
    state_id: Option<&str>,
    priority: Option<u8>,
    label_id: Option<&str>,
) -> Result<IssuePage> {
    issues(
        token,
        json!({ "assignee": { "id": { "eq": assignee_id } } }),
        search,
        after,
        include_archived,
        state_id,
        priority,
        None,
        label_id,
        None,
    )
    .await
}

pub async fn team_issues(
    token: &str,
    team_id: &str,
    search: Option<&str>,
    after: Option<&str>,
    include_archived: bool,
    state_id: Option<&str>,
    priority: Option<u8>,
    assignee_id: Option<&str>,
    label_id: Option<&str>,
    cycle_id: Option<&str>,
) -> Result<IssuePage> {
    issues(
        token,
        json!({ "team": { "id": { "eq": team_id } } }),
        search,
        after,
        include_archived,
        state_id,
        priority,
        assignee_id,
        label_id,
        cycle_id,
    )
    .await
}

async fn issues(
    token: &str,
    filter: Value,
    search: Option<&str>,
    after: Option<&str>,
    include_archived: bool,
    state_id: Option<&str>,
    priority: Option<u8>,
    assignee_id: Option<&str>,
    label_id: Option<&str>,
    cycle_id: Option<&str>,
) -> Result<IssuePage> {
    #[derive(Deserialize)]
    struct Data {
        issues: IssueConnection,
    }

    let filter = with_issue_filters(
        filter,
        search,
        state_id,
        priority,
        assignee_id,
        label_id,
        cycle_id,
    );
    let data: Data = query(
        token,
        "query RelayIssues($filter: IssueFilter, $after: String, $includeArchived: Boolean!) { issues(filter: $filter, includeArchived: $includeArchived, first: 50, after: $after) { nodes { id identifier title description url priority updatedAt archivedAt state { id name type } assignee { id name } project { id name } cycle { id name number } labels { nodes { id name color } } team { id name key } } pageInfo { endCursor hasNextPage } } }",
        json!({
            "filter": filter,
            "after": after,
            "includeArchived": include_archived
        }),
    )
    .await?;
    Ok(IssuePage {
        issues: data.issues.nodes,
        end_cursor: data.issues.page_info.end_cursor,
        has_next_page: data.issues.page_info.has_next_page,
    })
}

fn with_issue_filters(
    filter: Value,
    search: Option<&str>,
    state_id: Option<&str>,
    priority: Option<u8>,
    assignee_id: Option<&str>,
    label_id: Option<&str>,
    cycle_id: Option<&str>,
) -> Value {
    let mut filters = vec![filter];
    if let Some(search) = search.map(str::trim).filter(|search| !search.is_empty()) {
        filters.push(json!({ "title": { "contains": search } }));
    }
    if let Some(state_id) = state_id {
        filters.push(json!({ "state": { "id": { "eq": state_id } } }));
    }
    if let Some(priority) = priority {
        filters.push(json!({ "priority": { "eq": priority } }));
    }
    if let Some(assignee_id) = assignee_id {
        filters.push(if assignee_id == "unassigned" {
            json!({ "assignee": { "null": true } })
        } else {
            json!({ "assignee": { "id": { "eq": assignee_id } } })
        });
    }
    if let Some(label_id) = label_id {
        filters.push(json!({ "labels": { "some": { "id": { "eq": label_id } } } }));
    }
    if let Some(cycle_id) = cycle_id {
        filters.push(if cycle_id == "uncycled" {
            json!({ "cycle": { "null": true } })
        } else {
            json!({ "cycle": { "id": { "eq": cycle_id } } })
        });
    }
    if filters.len() == 1 {
        filters
            .pop()
            .expect("the base issue scope is always present")
    } else {
        json!({ "and": filters })
    }
}

pub async fn archive_issue(token: &str, issue_id: &str) -> Result<()> {
    #[derive(Deserialize)]
    struct Data {
        #[serde(rename = "issueArchive")]
        result: DeleteMutation,
    }
    let data: Data = query(
        token,
        "mutation RelayIssueArchive($id: String!) { issueArchive(id: $id) { success } }",
        json!({ "id": issue_id }),
    )
    .await?;
    if data.result.success {
        Ok(())
    } else {
        Err(Error::LinearApi("Linear did not archive the issue".into()))
    }
}

pub async fn unarchive_issue(token: &str, issue_id: &str) -> Result<()> {
    #[derive(Deserialize)]
    struct Data {
        #[serde(rename = "issueUnarchive")]
        result: DeleteMutation,
    }
    let data: Data = query(
        token,
        "mutation RelayIssueUnarchive($id: String!) { issueUnarchive(id: $id) { success } }",
        json!({ "id": issue_id }),
    )
    .await?;
    if data.result.success {
        Ok(())
    } else {
        Err(Error::LinearApi("Linear did not restore the issue".into()))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IssuePage {
    pub issues: Vec<Issue>,
    pub end_cursor: Option<String>,
    pub has_next_page: bool,
}

#[derive(Deserialize)]
struct Nodes<T> {
    nodes: Vec<T>,
}

#[derive(Deserialize)]
struct IssueConnection {
    nodes: Vec<Issue>,
    #[serde(rename = "pageInfo")]
    page_info: PageInfo,
}

#[derive(Deserialize)]
struct ProjectConnection {
    nodes: Vec<LinearProject>,
    #[serde(rename = "pageInfo")]
    page_info: PageInfo,
}

#[derive(Deserialize)]
struct ResourceConnection<T> {
    nodes: Vec<T>,
    #[serde(rename = "pageInfo")]
    page_info: PageInfo,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PageInfo {
    end_cursor: Option<String>,
    has_next_page: bool,
}

fn next_page_cursor(page_info: &PageInfo, collection: &str) -> Result<Option<String>> {
    if !page_info.has_next_page {
        return Ok(None);
    }
    page_info
        .end_cursor
        .clone()
        .map(Some)
        .ok_or_else(|| Error::LinearApi(format!("Linear returned an incomplete {collection} page")))
}

async fn query<T: DeserializeOwned>(token: &str, query: &str, variables: Value) -> Result<T> {
    let response = reqwest::Client::new()
        .post(GRAPHQL)
        .bearer_auth(token)
        .json(&json!({ "query": query, "variables": variables }))
        .send()
        .await
        .map_err(|_| Error::LinearApi("could not reach Linear".into()))?
        .error_for_status()
        .map_err(|error| {
            Error::LinearApi(format!(
                "Linear returned HTTP {}",
                error.status().unwrap_or_default()
            ))
        })?
        .json::<GraphqlResponse<T>>()
        .await
        .map_err(|_| Error::LinearApi("Linear returned an invalid response".into()))?;

    if !response.errors.is_empty() {
        return Err(Error::LinearApi(response.errors[0].message.clone()));
    }
    response
        .data
        .ok_or_else(|| Error::LinearApi("Linear returned no data".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pagination_requires_a_cursor_only_when_another_page_exists() {
        assert_eq!(
            next_page_cursor(
                &PageInfo {
                    end_cursor: Some("next".into()),
                    has_next_page: true,
                },
                "cycle"
            )
            .unwrap(),
            Some("next".into())
        );
        assert_eq!(
            next_page_cursor(
                &PageInfo {
                    end_cursor: None,
                    has_next_page: false,
                },
                "cycle"
            )
            .unwrap(),
            None
        );
        assert!(next_page_cursor(
            &PageInfo {
                end_cursor: None,
                has_next_page: true,
            },
            "cycle"
        )
        .is_err());
    }

    #[derive(Deserialize, Serialize)]
    struct LabelResponse {
        #[serde(with = "label_nodes")]
        labels: Vec<LinearLabel>,
    }

    #[test]
    fn issue_label_connection_round_trips_as_a_flat_list() {
        let labels: LabelResponse = serde_json::from_value(json!({
            "labels": { "nodes": [{ "id": "label-1", "name": "Bug", "color": "#ff0000", "team": null }] }
        }))
        .unwrap();
        assert_eq!(labels.labels[0].id, "label-1");
        let encoded = serde_json::to_value(labels).unwrap();
        assert_eq!(encoded["labels"][0]["id"], "label-1");
    }

    #[test]
    fn project_resources_decode_linear_documents_and_links() {
        let documents: ResourceConnection<LinearDocument> = serde_json::from_value(json!({
            "nodes": [{
                "id": "doc-1",
                "title": "Plan",
                "url": "https://linear.app/acme/document/doc-1",
                "updatedAt": "2026-09-28T12:00:00.000Z",
                "creator": { "id": "user-1", "name": "Ada" }
            }],
            "pageInfo": { "endCursor": "next", "hasNextPage": true }
        }))
        .unwrap();
        assert!(documents.page_info.has_next_page);
        assert_eq!(documents.page_info.end_cursor.as_deref(), Some("next"));
        assert_eq!(documents.nodes[0].creator.as_ref().unwrap().name, "Ada");

        let link: ExternalLinkMutation = serde_json::from_value(json!({
            "success": true,
            "entityExternalLink": {
                "id": "link-1",
                "label": "Design",
                "url": "https://example.com/design"
            }
        }))
        .unwrap();
        assert_eq!(link.into_value("failed").unwrap().label, "Design");
    }

    #[test]
    fn linear_project_decodes_explicit_repository_links() {
        let project: LinearProject = serde_json::from_value(json!({
            "id": "project-1",
            "name": "Relay release",
            "externalLinks": { "nodes": [{
                "id": "link-1",
                "label": "GitHub: openai/relay",
                "url": "https://github.com/openai/relay"
            }] }
        }))
        .unwrap();

        assert_eq!(
            project.external_links[0].url,
            "https://github.com/openai/relay"
        );
    }

    #[test]
    fn project_document_save_rejects_a_stale_version() {
        assert!(ensure_document_fresh("2026-09-28T12:00:00Z", "2026-09-28T12:00:00Z").is_ok());
        let error =
            ensure_document_fresh("2026-09-28T12:01:00Z", "2026-09-28T12:00:00Z").unwrap_err();
        assert!(error.to_string().contains("changed in Linear"));
    }

    #[test]
    fn relay_agent_rejects_issues_outside_the_allowed_project() {
        assert!(issue_matches_project(Some("project-1"), "project-1"));
        assert!(!issue_matches_project(Some("project-2"), "project-1"));
        assert!(!issue_matches_project(None, "project-1"));
    }

    #[test]
    fn issue_label_mutation_decodes_linear_payload_and_requires_a_label() {
        let result: IssueLabelMutation = serde_json::from_value(json!({
            "success": true,
            "issueLabel": {
                "id": "label-1",
                "name": "Bug",
                "color": "#ff0000",
                "team": { "id": "team-1" }
            }
        }))
        .unwrap();
        let label = result.into_value("failed").unwrap();
        assert_eq!(label.name, "Bug");
        assert_eq!(label.team.unwrap().id, "team-1");

        let missing: IssueLabelMutation =
            serde_json::from_value(json!({ "success": true, "issueLabel": null })).unwrap();
        assert!(missing.into_value("failed").is_err());
    }

    #[test]
    fn issue_filters_preserve_scope_and_compose_search_status_priority_labels_and_cycles() {
        let team = json!({ "team": { "id": { "eq": "team-1" } } });
        assert_eq!(
            with_issue_filters(team.clone(), None, None, None, None, None, None),
            team
        );
        assert_eq!(
            with_issue_filters(
                team,
                Some("  deploy  "),
                Some("state-1"),
                Some(1),
                None,
                None,
                None,
            ),
            json!({
                "and": [
                    { "team": { "id": { "eq": "team-1" } } },
                    { "title": { "contains": "deploy" } },
                    { "state": { "id": { "eq": "state-1" } } },
                    { "priority": { "eq": 1 } }
                ]
            })
        );
        assert_eq!(
            with_issue_filters(
                json!({ "project": { "id": { "eq": "project-1" } } }),
                Some("release"),
                Some("state-2"),
                Some(2),
                Some("user-1"),
                Some("label-1"),
                Some("cycle-1"),
            ),
            json!({
                "and": [
                    { "project": { "id": { "eq": "project-1" } } },
                    { "title": { "contains": "release" } },
                    { "state": { "id": { "eq": "state-2" } } },
                    { "priority": { "eq": 2 } },
                    { "assignee": { "id": { "eq": "user-1" } } },
                    { "labels": { "some": { "id": { "eq": "label-1" } } } },
                    { "cycle": { "id": { "eq": "cycle-1" } } }
                ]
            })
        );
        assert_eq!(
            with_issue_filters(
                json!({ "project": { "id": { "eq": "project-1" } } }),
                None,
                None,
                None,
                Some("unassigned"),
                None,
                None,
            ),
            json!({
                "and": [
                    { "project": { "id": { "eq": "project-1" } } },
                    { "assignee": { "null": true } }
                ]
            })
        );
        assert_eq!(
            with_issue_filters(
                json!({ "team": { "id": { "eq": "team-1" } } }),
                None,
                None,
                None,
                None,
                None,
                Some("uncycled"),
            ),
            json!({
                "and": [
                    { "team": { "id": { "eq": "team-1" } } },
                    { "cycle": { "null": true } }
                ]
            })
        );
    }

    #[test]
    fn issue_archived_at_decodes_and_defaults_for_active_issues() {
        let archived: Issue = serde_json::from_value(json!({
            "id": "issue-1",
            "identifier": "ENG-1",
            "title": "Archived",
            "archivedAt": "2026-09-27T20:00:00.000Z",
            "labels": { "nodes": [] },
            "team": { "id": "team-1", "name": "Engineering", "key": "ENG" }
        }))
        .unwrap();
        assert_eq!(
            archived.archived_at.as_deref(),
            Some("2026-09-27T20:00:00.000Z")
        );

        let active: Issue = serde_json::from_value(json!({
            "id": "issue-2",
            "identifier": "ENG-2",
            "title": "Active",
            "labels": { "nodes": [] },
            "team": { "id": "team-1", "name": "Engineering", "key": "ENG" }
        }))
        .unwrap();
        assert_eq!(active.archived_at, None);
    }

    #[test]
    fn project_status_and_lead_decode_from_linear_fields() {
        let project: LinearProject = serde_json::from_value(json!({
            "id": "project-1",
            "name": "Launch",
            "archivedAt": "2026-09-27T20:00:00.000Z",
            "status": { "id": "status-1", "name": "In Progress", "type": "started" },
            "lead": { "id": "user-1", "name": "Alex" },
            "teams": { "nodes": [
                { "id": "team-1", "name": "Engineering", "key": "ENG" },
                { "id": "team-2", "name": "Design", "key": "DES" }
            ] }
        }))
        .unwrap();
        assert_eq!(
            project.archived_at.as_deref(),
            Some("2026-09-27T20:00:00.000Z")
        );
        assert_eq!(project.status.as_ref().unwrap().kind, "started");
        assert_eq!(project.lead.as_ref().unwrap().id, "user-1");
        assert_eq!(project.teams.len(), 2);
        assert_eq!(project.teams[1].key, "DES");
    }

    #[test]
    fn project_connection_decodes_pagination_state() {
        let connection: ProjectConnection = serde_json::from_value(json!({
            "nodes": [],
            "pageInfo": { "endCursor": "cursor-1", "hasNextPage": true }
        }))
        .unwrap();
        assert!(connection.nodes.is_empty());
        assert_eq!(connection.page_info.end_cursor.as_deref(), Some("cursor-1"));
        assert!(connection.page_info.has_next_page);
    }

    #[test]
    fn initiative_mutation_accepts_sparse_payload_and_defaults_projects() {
        let mutation: InitiativeMutation = serde_json::from_value(json!({
            "success": true,
            "initiative": {
                "id": "initiative-1",
                "name": "Roadmap",
                "description": null,
                "targetDate": "2026-12-31"
            }
        }))
        .unwrap();
        let initiative = mutation.into_value("failed").unwrap();
        assert_eq!(initiative.target_date.as_deref(), Some("2026-12-31"));
        assert!(initiative.projects.is_empty());
    }

    #[test]
    fn initiative_update_mutation_decodes_health_and_author() {
        let mutation: InitiativeUpdateMutation = serde_json::from_value(json!({
            "success": true,
            "initiativeUpdate": {
                "id": "update-1",
                "body": "Launch remains on schedule.",
                "health": "onTrack",
                "createdAt": "2026-09-27T20:00:00.000Z",
                "archivedAt": null,
                "user": { "id": "user-1", "name": "Alex" }
            }
        }))
        .unwrap();
        let update = mutation.into_value("failed").unwrap();
        assert_eq!(update.id, "update-1");
        assert_eq!(update.health, "onTrack");
        assert_eq!(update.user.name, "Alex");
    }

    #[test]
    fn comment_mutation_decodes_edit_time_and_author() {
        let mutation: CommentMutation = serde_json::from_value(json!({
            "success": true,
            "comment": {
                "id": "comment-1",
                "body": "Updated details.",
                "createdAt": "2026-09-27T20:00:00.000Z",
                "editedAt": "2026-09-27T20:05:00.000Z",
                "user": { "id": "user-1", "name": "Alex" }
            }
        }))
        .unwrap();
        let comment = mutation.into_value("failed").unwrap();
        assert_eq!(
            comment.edited_at.as_deref(),
            Some("2026-09-27T20:05:00.000Z")
        );
        assert_eq!(comment.user.unwrap().id, "user-1");
    }

    #[test]
    fn cycle_create_input_keeps_required_dates_and_omits_an_empty_name() {
        assert_eq!(
            cycle_create_input(
                "team-1",
                Some("  "),
                "2026-10-01T07:00:00.000Z",
                "2026-10-15T07:00:00.000Z",
            ),
            json!({
                "teamId": "team-1",
                "startsAt": "2026-10-01T07:00:00.000Z",
                "endsAt": "2026-10-15T07:00:00.000Z"
            })
        );
    }

    #[test]
    fn initiative_project_link_keeps_the_relation_id_for_unlinking() {
        let link: InitiativeProject = serde_json::from_value(json!({
            "id": "link-1",
            "project": { "id": "project-1", "name": "Launch" }
        }))
        .unwrap();
        assert_eq!(link.id, "link-1");
        assert_eq!(link.project.id, "project-1");
    }
}
