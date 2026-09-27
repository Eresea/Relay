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
    pub user: Option<Person>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueDetail {
    pub issue: Issue,
    pub children: Vec<Issue>,
    pub comments: Vec<LinearComment>,
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
    pub projects: Vec<InitiativeProject>,
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
            "query RelayProjects($includeArchived: Boolean!, $after: String) { projects(first: 100, after: $after, includeArchived: $includeArchived) { nodes { id name description url startDate targetDate archivedAt status { id name type } lead { id name } } pageInfo { endCursor hasNextPage } } }",
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
    team_id: &str,
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
        ("teamIds".into(), json!([team_id])),
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
        "mutation RelayProjectCreate($input: ProjectCreateInput!) { projectCreate(input: $input) { success project { id name description url startDate targetDate archivedAt status { id name type } lead { id name } } } }",
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
    let data: Data = query(
        token,
        "mutation RelayProjectUpdate($id: String!, $input: ProjectUpdateInput!) { projectUpdate(id: $id, input: $input) { success project { id name description url startDate targetDate archivedAt status { id name type } lead { id name } } } }",
        json!({ "id": project_id, "input": input }),
    )
    .await?;
    data.result.into_value("Linear did not update the project")
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
        project_milestones: Nodes<LinearMilestone>,
    }
    #[derive(Deserialize)]
    struct Data {
        projects: Nodes<ProjectNode>,
    }
    let data: Data = query(
        token,
        "query RelayProjectMilestones($projectId: String!) { projects(filter: { id: { eq: $projectId } }, first: 1) { nodes { projectMilestones(first: 100) { nodes { id name description targetDate } } } } }",
        json!({ "projectId": project_id }),
    )
    .await?;
    Ok(data
        .projects
        .nodes
        .into_iter()
        .next()
        .map(|project| project.project_milestones.nodes)
        .unwrap_or_default())
}

pub async fn project_updates(
    token: &str,
    project_id: &str,
    include_archived: bool,
) -> Result<Vec<LinearProjectUpdate>> {
    #[derive(Deserialize)]
    struct ProjectNode {
        project_updates: Nodes<LinearProjectUpdate>,
    }
    #[derive(Deserialize)]
    struct Data {
        projects: Nodes<ProjectNode>,
    }
    let data: Data = query(
        token,
        "query RelayProjectUpdates($projectId: String!, $includeArchived: Boolean!) { projects(filter: { id: { eq: $projectId } }, first: 1) { nodes { projectUpdates(first: 50, includeArchived: $includeArchived, orderBy: createdAt) { nodes { id body health createdAt archivedAt user { id name } } } } } }",
        json!({ "projectId": project_id, "includeArchived": include_archived }),
    )
    .await?;
    Ok(data
        .projects
        .nodes
        .into_iter()
        .next()
        .map(|project| project.project_updates.nodes)
        .unwrap_or_default())
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

pub async fn initiatives(token: &str) -> Result<Vec<Initiative>> {
    #[derive(Deserialize)]
    struct InitiativeNode {
        id: String,
        name: String,
        description: Option<String>,
        #[serde(rename = "targetDate")]
        target_date: Option<String>,
    }
    #[derive(Deserialize)]
    struct Data {
        initiatives: Nodes<InitiativeNode>,
        #[serde(rename = "initiativeToProjects")]
        project_links: Nodes<InitiativeProjectNode>,
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
    let data = query::<Data>(
        token,
        "query RelayInitiatives { initiatives(first: 100) { nodes { id name description targetDate } } initiativeToProjects(first: 100) { nodes { id initiative { id } project { id name } } } }",
        json!({}),
    )
    .await?;
    let mut projects = HashMap::<String, Vec<InitiativeProject>>::new();
    for link in data.project_links.nodes {
        projects
            .entry(link.initiative.id)
            .or_default()
            .push(InitiativeProject {
                id: link.id,
                project: link.project,
            });
    }
    Ok(data
        .initiatives
        .nodes
        .into_iter()
        .map(|initiative| Initiative {
            id: initiative.id.clone(),
            name: initiative.name,
            description: initiative.description,
            target_date: initiative.target_date,
            projects: projects.remove(&initiative.id).unwrap_or_default(),
        })
        .collect())
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
        cycles: Nodes<LinearCycle>,
    }
    Ok(query::<Data>(
        token,
        "query RelayCycles($teamId: String!) { cycles(filter: { team: { id: { eq: $teamId } } }, first: 100) { nodes { id name description number startsAt endsAt isActive team { id name key timezone } } } }",
        json!({ "teamId": team_id }),
    )
    .await?
    .cycles
    .nodes)
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
) -> Result<IssuePage> {
    issues(
        token,
        json!({ "project": { "id": { "eq": project_id } } }),
        after,
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
    project_id: Option<&str>,
    project_milestone_id: Option<&str>,
    parent_id: Option<&str>,
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
    if let Some(project_id) = project_id {
        input.insert("projectId".into(), json!(project_id));
    }
    if let Some(project_milestone_id) = project_milestone_id {
        input.insert("projectMilestoneId".into(), json!(project_milestone_id));
    }
    if let Some(parent_id) = parent_id {
        input.insert("parentId".into(), json!(parent_id));
    }
    let data: Data = query(
        token,
        "mutation RelayIssueCreate($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier title description url priority estimate updatedAt state { id name type } assignee { id name } project { id name } cycle { id name number } labels { nodes { id name color } } team { id name key } } } }",
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
    }
    #[derive(Deserialize)]
    struct Data {
        issue: IssueNode,
    }
    let data: Data = query(
        token,
        "query RelayIssueDetail($id: String!) { issue(id: $id) { id identifier title description url priority estimate dueDate updatedAt state { id name type } assignee { id name } project { id name } projectMilestone { id name } cycle { id name number } labels { nodes { id name color } } team { id name key } children(first: 50) { nodes { id identifier title description url priority updatedAt state { id name type } assignee { id name } project { id name } cycle { id name number } labels { nodes { id name color } } team { id name key } } } comments(first: 50) { nodes { id body createdAt user { id name } } } } }",
        json!({ "id": issue_id }),
    )
    .await?;
    Ok(IssueDetail {
        issue: data.issue.issue,
        children: data.issue.children.nodes,
        comments: data.issue.comments.nodes,
    })
}

pub async fn create_comment(token: &str, issue_id: &str, body: &str) -> Result<LinearComment> {
    #[derive(Deserialize)]
    struct Data {
        #[serde(rename = "commentCreate")]
        result: CommentMutation,
    }
    let data: Data = query(
        token,
        "mutation RelayCommentCreate($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id body createdAt user { id name } } } }",
        json!({ "input": { "issueId": issue_id, "body": body } }),
    )
    .await?;
    data.result.into_value("Linear did not create the comment")
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
struct InitiativeProjectMutation {
    success: bool,
    #[serde(rename = "initiativeToProject")]
    initiative_project: Option<InitiativeProject>,
}

#[derive(Deserialize)]
struct DeleteMutation {
    success: bool,
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

pub async fn my_issues(token: &str, assignee_id: &str, after: Option<&str>) -> Result<IssuePage> {
    issues(
        token,
        json!({ "assignee": { "id": { "eq": assignee_id } } }),
        after,
    )
    .await
}

pub async fn team_issues(token: &str, team_id: &str, after: Option<&str>) -> Result<IssuePage> {
    issues(token, json!({ "team": { "id": { "eq": team_id } } }), after).await
}

async fn issues(token: &str, filter: Value, after: Option<&str>) -> Result<IssuePage> {
    #[derive(Deserialize)]
    struct Data {
        issues: IssueConnection,
    }

    let data: Data = query(
        token,
        "query RelayIssues($filter: IssueFilter, $after: String) { issues(filter: $filter, first: 50, after: $after) { nodes { id identifier title description url priority updatedAt state { id name type } assignee { id name } project { id name } cycle { id name number } labels { nodes { id name color } } team { id name key } } pageInfo { endCursor hasNextPage } } }",
        json!({
            "filter": filter,
            "after": after
        }),
    )
    .await?;
    Ok(IssuePage {
        issues: data.issues.nodes,
        end_cursor: data.issues.page_info.end_cursor,
        has_next_page: data.issues.page_info.has_next_page,
    })
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
#[serde(rename_all = "camelCase")]
struct PageInfo {
    end_cursor: Option<String>,
    has_next_page: bool,
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
    fn project_status_and_lead_decode_from_linear_fields() {
        let project: LinearProject = serde_json::from_value(json!({
            "id": "project-1",
            "name": "Launch",
            "archivedAt": "2026-09-27T20:00:00.000Z",
            "status": { "id": "status-1", "name": "In Progress", "type": "started" },
            "lead": { "id": "user-1", "name": "Alex" }
        }))
        .unwrap();
        assert_eq!(
            project.archived_at.as_deref(),
            Some("2026-09-27T20:00:00.000Z")
        );
        assert_eq!(project.status.as_ref().unwrap().kind, "started");
        assert_eq!(project.lead.as_ref().unwrap().id, "user-1");
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
